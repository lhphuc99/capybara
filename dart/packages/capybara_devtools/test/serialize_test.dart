import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:capybara_devtools/src/core/serialize.dart';
import 'package:flutter_test/flutter_test.dart';

enum _Status { active }

final class _Point {
  _Point(this.x);

  final int x;

  Map<String, Object?> toJson() => {'x': x};
}

final class _Listed {
  List<Object?> get props => [1, 'a'];
}

final class _Plain {
  @override
  String toString() => 'Plain(1)';
}

final class _Throws {
  Map<String, Object?> toJson() => throw StateError('no');

  @override
  String toString() => throw StateError('no');
}

final class _NotFound implements Exception {
  @override
  String toString() => 'NotFound: user 7';
}

void _load() {}

void main() {
  test('keeps what JSON carries as it is', () {
    final value = {
      'a': 1,
      'b': 'x',
      'c': [true, null, 1.5],
    };
    expect(serialize(value), value);
  });

  test('tags values JSON cannot carry, the way the UI reads them from JS', () {
    expect(serialize(double.nan), {r'$t': 'number', 'v': 'NaN'});
    expect(serialize(double.negativeInfinity), {r'$t': 'number', 'v': '-Infinity'});
    expect(serialize(-0.0), {r'$t': 'number', 'v': '-0'});
    expect(serialize(9007199254740993), {r'$t': 'number', 'v': '9007199254740993'});
    expect(serialize(-9223372036854775808), {r'$t': 'number', 'v': '-9223372036854775808'});
    expect(serialize(9007199254740991), 9007199254740991);
    expect(serialize(BigInt.parse('123456789012345678901234567890')), {
      r'$t': 'bigint',
      'v': '123456789012345678901234567890',
    });
    expect(serialize(DateTime.utc(2026, 1, 2, 3, 4, 5, 6)), {r'$t': 'date', 'v': '2026-01-02T03:04:05.006Z'});
    expect(serialize(RegExp('a+', caseSensitive: false, multiLine: true)), {r'$t': 'regexp', 'v': '/a+/im'});
    expect(serialize(#id), {r'$t': 'symbol', 'v': 'Symbol("id")'});
    expect(serialize(_load), {r'$t': 'function', 'name': '_load'});
    expect(serialize(() {}), {r'$t': 'function', 'name': 'anonymous'});
    expect(serialize(_Status.active), {r'$t': 'node', 'v': '_Status.active'});
    expect(serialize(const Duration(seconds: 90)), {r'$t': 'node', 'v': '0:01:30.000000'});
    expect(serialize(Uint8List(4)), {r'$t': 'binary', 'name': 'Uint8List', 'size': 4});
    expect(serialize(Future<void>.value()), {r'$t': 'object', 'name': 'Future', 'props': <String, Object?>{}});
    expect(serialize(const Stream<int>.empty()), {r'$t': 'object', 'name': 'Stream', 'props': <String, Object?>{}});
  });

  test('describes maps, sets and objects', () {
    expect(serialize({1: 'a'}), {
      r'$t': 'map',
      'entries': [
        [1, 'a'],
      ],
      'size': 1,
    });
    expect(serialize({1, 2}), {
      r'$t': 'set',
      'values': [1, 2],
      'size': 2,
    });
    expect(serialize({r'$t': 'fake'}), {
      r'$t': 'object',
      'props': {r'$t': 'fake'},
    });
    expect(serialize(_Point(1)), {
      r'$t': 'object',
      'name': 'Point',
      'props': {'x': 1},
    });
    expect(serialize(_Listed()), {
      r'$t': 'object',
      'name': 'Listed',
      'props': {'0': 1, '1': 'a'},
    });
    expect(serialize(_Plain()), {r'$t': 'node', 'v': 'Plain(1)'});
  });

  test('marks cycles but repeats shared values', () {
    final shared = {'x': 1};
    final root = <String, Object?>{'left': shared, 'right': shared};
    root['self'] = root;
    expect(serialize(root), {
      'left': {'x': 1},
      'right': {'x': 1},
      'self': {r'$t': 'circular'},
    });
  });

  test('cuts long strings, lists, wide maps and deep nesting', () {
    expect(serialize('x' * 20, const SerializeOptions(maxString: 5)), {r'$t': 'string', 'v': 'xxxxx', 'length': 20});
    expect(serialize([1, 2, 3], const SerializeOptions(maxItems: 2)), {
      r'$t': 'array',
      'items': [1, 2],
      'length': 3,
    });
    expect(serialize({'a': 1, 'b': 2, 'c': 3}, const SerializeOptions(maxKeys: 2)), {
      r'$t': 'object',
      'props': {'a': 1, 'b': 2},
      'more': 1,
    });
    expect(
      serialize({
        'a': {
          'b': {'c': 1},
        },
      }, const SerializeOptions(maxDepth: 2)),
      {
        'a': {
          'b': {r'$t': 'limit', 'name': 'Map(1)'},
        },
      },
    );
    final wide = [for (var i = 0; i < 50; i++) <int>[]];
    final cut = serialize(wide, const SerializeOptions(maxNodes: 10))! as List;
    expect(cut.whereType<Map<String, Object?>>().where((item) => item[r'$t'] == 'limit'), hasLength(41));
  });

  test('names errors without the leading underscore or the name again in the message', () {
    final error = serialize(Exception('boom'))! as Map<String, Object?>;
    expect(error, {r'$t': 'error', 'name': 'Exception', 'message': 'boom'});
    expect(serialize(_NotFound()), {r'$t': 'error', 'name': 'NotFound', 'message': 'user 7'});

    Object? thrown;
    try {
      throw StateError('closed');
    } catch (e) {
      thrown = e;
    }
    final state = serialize(thrown)! as Map<String, Object?>;
    expect(state, containsPair('name', 'StateError'));
    expect(state, containsPair('message', 'Bad state: closed'));
    expect(state['stack'], contains('serialize_test.dart'));

    final withStack = serializeError('plain text', StackTrace.fromString('#0 main (package:app/main.dart:1:1)'));
    expect(withStack, {
      r'$t': 'error',
      'name': 'String',
      'message': 'plain text',
      'stack': '#0 main (package:app/main.dart:1:1)',
    });
  });

  test('survives objects whose methods throw, and the result always encodes', () {
    expect(serialize(_Throws()), {r'$t': 'node', 'v': 'Instance of _Throws'});
    final everything = [
      double.nan,
      _Throws(),
      {1: Object()},
      Uint8List(2),
      _Status.active,
      Exception('x'),
      #s,
      DateTime(2026),
    ];
    expect(() => jsonEncode(serialize(everything)), returnsNormally);
  });

  test('matches the ISO text JS gives dates', () {
    expect(isoUtc(DateTime.utc(2026, 10, 28, 3, 29, 36, 123, 999)), '2026-10-28T03:29:36.123Z');
    expect(isoUtc(DateTime.utc(12, 1, 1)), '0012-01-01T00:00:00.000Z');
  });

  test('stays out of the zone it is called in', () {
    final printed = <String>[];
    runZoned(
      () => serialize({'a': 1}),
      zoneSpecification: ZoneSpecification(print: (_, _, _, line) => printed.add(line)),
    );
    expect(printed, isEmpty);
  });
}
