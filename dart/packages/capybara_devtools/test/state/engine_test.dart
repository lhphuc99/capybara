import 'package:capybara_devtools/src/state/engine.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

final class _Item {
  _Item(this.name, this.qty);

  final String name;
  final int qty;

  Map<String, Object?> toJson() => {'name': name, 'qty': qty};
}

final class _Props {
  _Props(this.a, this.b);

  final int a;
  final String b;

  List<Object?> get props => [a, b];
}

List<Object?> _paths(List<Map<String, Object?>> ops) => [for (final op in ops) '${op['op']} ${op['path']}'];

void main() {
  group('diffState', () {
    test('finds nothing when the reference is the same, and walks only into changed branches', () {
      final shared = {'deep': List.filled(1000, 1)};
      final state = {'a': shared, 'b': 1};
      expect(diffState(state, state).ops, isEmpty);
      final next = {'a': shared, 'b': 2};
      final diff = diffState(state, next);
      expect(_paths(diff.ops), ['set [b]']);
      expect(diff.ops.single['value'], 2);
      expect(diff.ops.single['prev'], 1);
    });

    test('compares lists by index, adding and removing at the end, and maps by key', () {
      expect(
        _paths(
          diffState(
            {
              'list': [1, 2, 3],
              'gone': true,
            },
            {
              'list': [1, 5],
              'new': 'x',
            },
          ).ops,
        ),
        ['set [list, 1]', 'del [list, 2]', 'add [new]', 'del [gone]'],
      );
    });

    test('walks into objects through toJson and Equatable props, and keeps equal leaves quiet', () {
      final before = {
        'items': [_Item('tea', 1)],
        'pair': _Props(1, 'x'),
        'at': DateTime.utc(2026),
      };
      final after = {
        'items': [_Item('tea', 2)],
        'pair': _Props(1, 'y'),
        'at': DateTime.utc(2026),
      };
      expect(_paths(diffState(before, after).ops), ['set [items, 0, qty]', 'set [pair, 1]']);
    });

    test('keeps the first 100 ops and counts the rest, and keeps int keys as numbers', () {
      final diff = diffState(<int, int>{}, {for (var i = 0; i < 150; i++) i: i});
      expect(diff.ops, hasLength(100));
      expect(diff.opCount, 150);
      expect(diff.ops.first['path'], [0]);
    });

    test('replaces a whole state of another shape', () {
      expect(_paths(diffState({'a': 1}, [1]).ops), ['set []']);
    });
  });

  group('readPath', () {
    final state = {
      'cart': {
        'items': [_Item('tea', 2)],
      },
      7: 'by int',
    };

    test('follows keys into maps, lists and objects', () {
      expect(readPath(state, ['cart', 'items', 0, 'name']), (found: true, value: 'tea'));
      expect(readPath(state, ['cart', 'items', '0', 'qty']), (found: true, value: 2));
      expect(readPath(state, ['7']), (found: true, value: 'by int'));
    });

    test('tells a missing step from a value that is null', () {
      expect(readPath({'a': null}, ['a']), (found: true, value: null));
      expect(readPath(state, ['cart', 'nope']).found, isFalse);
      expect(readPath(state, ['cart', 'items', 5]).found, isFalse);
    });
  });

  group('StateEngine', () {
    late List<(String, Map<String, Object?>)> events;
    var connected = true;

    StateEngine engine() {
      events = [];
      connected = true;
      return StateEngine((kind, payload, {ts}) => events.add((kind, payload)), connected: () => connected);
    }

    List<Map<String, Object?>> changes() => [
      for (final (kind, payload) in events)
        if (kind == 'state.change') payload,
    ];

    test('announces a store, then sends what changed a moment later', () {
      fakeAsync((async) {
        final states = engine();
        var state = {'count': 0};
        states.track('bloc:1', {
          'library': 'bloc',
          'label': 'Counter',
          'via': 'observer',
          'actions': true,
        }, () => state);
        expect(events.single.$1, 'state.store');
        state = {'count': 1};
        states.record('bloc:1', state, action: {'type': 'Increment'});
        expect(changes(), isEmpty);
        async.elapse(const Duration(milliseconds: 100));
        expect(changes().single, {
          'store': 'bloc:1',
          'rev': 1,
          'cause': 'action',
          'action': {'type': 'Increment'},
          'ops': [
            {
              'op': 'set',
              'path': ['count'],
              'value': 1,
              'prev': 0,
            },
          ],
        });
      });
    });

    test('sends at most 30 records a second, the last of them carrying the rest', () {
      fakeAsync((async) {
        final states = engine();
        states.track('watch:1', {'label': 'n'}, () => 0);
        for (var i = 1; i <= 40; i++) {
          states.record('watch:1', i);
        }
        async.elapse(const Duration(milliseconds: 100));
        expect(changes(), hasLength(30));
        expect(changes().last['skipped'], 10);
        expect(changes().last['rev'], 30);
      });
    });

    test('only counts changes while offline, then sends one record with the count', () {
      fakeAsync((async) {
        final states = engine();
        states.track('watch:1', {'label': 'n'}, () => 0);
        connected = false;
        states
          ..record('watch:1', 1)
          ..record('watch:1', 2)
          ..record('watch:1', 3);
        async.elapse(const Duration(seconds: 2));
        expect(changes(), isEmpty);
        connected = true;
        async.elapse(const Duration(seconds: 1));
        expect(changes().single['skipped'], 2);
        expect((changes().single['ops']! as List).single, containsPair('value', 3));
      });
    });

    test('reads by path, says when the state moved on, and announces disposal', () {
      final states = engine();
      final state = {
        'user': {'name': 'Ada'},
      };
      states.track('riverpod:1', {'label': 'ProviderScope'}, () => state);
      expect(states.read('riverpod:1', ['user']), {
        'rev': 0,
        'pending': false,
        'value': {'name': 'Ada'},
        'truncated': false,
      });
      expect(() => states.read('riverpod:1', ['nope']), throwsA(isA<StateError>()));
      states.untrack('riverpod:1', note: 'Closed');
      expect(events.last.$2['store'], containsPair('disposed', true));
      expect(events.last.$2['store'], containsPair('note', 'Closed'));
    });

    test('cuts a large read to fit and says so', () {
      final states = engine();
      final big = [for (var i = 0; i < 400; i++) 'x' * 1000];
      states.track('watch:1', {'label': 'big'}, () => big);
      final read = states.read('watch:1', const []);
      expect(read['truncated'], isTrue);
    });
  });
}
