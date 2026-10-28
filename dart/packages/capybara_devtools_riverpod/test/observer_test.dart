import 'package:capybara_devtools/adapter.dart';
import 'package:capybara_devtools_riverpod/capybara_devtools_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:riverpod/riverpod.dart';

final class _Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final _counter = NotifierProvider<_Counter, int>(_Counter.new, name: 'counter');
final _greeting = Provider.family<String, String>((ref, name) => 'Hello $name', name: 'greeting');
final _user = FutureProvider<Map<String, Object?>>((ref) async => {'id': 7}, name: 'user');
final _temporary = Provider.autoDispose<int>((ref) => 42, name: 'temporary');

void main() {
  late List<(String, Map<String, Object?>)> events;
  late void Function() detach;

  setUp(() {
    events = [];
    detach = debugAttachStateEngine((kind, payload) => events.add((kind, payload)));
  });

  tearDown(() => detach());

  Future<void> flushed() => Future<void>.delayed(const Duration(milliseconds: 150));

  List<Map<String, Object?>> changes() => [
    for (final (kind, payload) in events)
      if (kind == 'state.change') payload,
  ];

  test('records each container as one store, its providers by name', () async {
    final container = ProviderContainer(observers: const [CapybaraRiverpodObserver()]);
    addTearDown(container.dispose);
    container.read(_counter);
    container.read(_counter.notifier).increment();
    expect(container.read(_greeting('Ada')), 'Hello Ada');
    await flushed();

    final store = events.firstWhere((event) => event.$1 == 'state.store').$2['store']! as Map;
    expect(store['library'], 'riverpod');
    expect(store['label'], startsWith('ProviderScope'));
    expect(store['actions'], isTrue);
    expect(
      [for (final change in changes()) (change['action']! as Map)['type']],
      ['counter', 'counter', 'greeting(Ada)'],
    );
    expect(changes()[1]['ops'], [
      {
        'op': 'set',
        'path': ['counter'],
        'value': 1,
        'prev': 0,
      },
    ]);
  });

  test('shows async values as loading, then their data', () async {
    final container = ProviderContainer(observers: const [CapybaraRiverpodObserver()]);
    addTearDown(container.dispose);
    await container.read(_user.future);
    await flushed();
    expect(changes().first['ops'], [
      {
        'op': 'add',
        'path': ['user'],
        'value': {'loading': true},
      },
    ]);
    expect(changes().last['ops'], [
      {
        'op': 'add',
        'path': ['user', 'data'],
        'value': {'id': 7},
      },
      {
        'op': 'del',
        'path': ['user', 'loading'],
        'prev': true,
      },
    ]);
  });

  test('takes a disposed provider out of the state', () async {
    final container = ProviderContainer(observers: const [CapybaraRiverpodObserver()]);
    addTearDown(container.dispose);
    final subscription = container.listen(_temporary, (_, _) {});
    subscription.close();
    await container.pump();
    await flushed();
    expect([for (final change in changes()) (change['action']! as Map)['type']], ['temporary', 'temporary disposed']);
    expect((changes().last['ops']! as List).single, containsPair('op', 'del'));
    // Read again, it comes back under the same name.
    container.listen(_temporary, (_, _) {});
    await flushed();
    expect((changes().last['action']! as Map)['type'], 'temporary');
  });
}
