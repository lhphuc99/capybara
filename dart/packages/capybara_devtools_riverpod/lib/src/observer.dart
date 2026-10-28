import 'package:capybara_devtools/adapter.dart';
import 'package:riverpod/misc.dart' show ProviderBase;
import 'package:riverpod/riverpod.dart';

/// Shows the providers of each `ProviderScope` in Capybara's State tab: one store per container, its state a map
/// from each provider's name to its value, and each change named after the provider that made it.
///
/// ```dart
/// runApp(const ProviderScope(observers: [CapybaraRiverpodObserver()], child: MyApp()));
/// ```
///
/// Providers without a `name` show as their type; riverpod_generator names them.
final class CapybaraRiverpodObserver extends ProviderObserver {
  const CapybaraRiverpodObserver();

  // The observer is const, so what it knows of each container lives here, and goes with the container.
  static final Expando<_Scope> _scopes = Expando('capybara.riverpod');
  static int _containers = 0;

  _Scope? _scope(ProviderContainer container) {
    final known = _scopes[container];
    if (known != null) return known;
    final scope = _Scope.track(++_containers == 1 ? 'ProviderScope' : 'ProviderScope #$_containers');
    if (scope != null) _scopes[container] = scope;
    return scope;
  }

  @override
  void didAddProvider(ProviderObserverContext context, Object? value) =>
      _scope(context.container)?.set(context.provider, value);

  @override
  void didUpdateProvider(ProviderObserverContext context, Object? previousValue, Object? newValue) =>
      _scope(context.container)?.set(context.provider, newValue);

  @override
  void providerDidFail(ProviderObserverContext context, Object error, StackTrace stackTrace) =>
      _scope(context.container)?.set(context.provider, {'error': '$error'});

  @override
  void didDisposeProvider(ProviderObserverContext context) => _scope(context.container)?.remove(context.provider);
}

final class _Scope {
  _Scope._(this.label);

  static _Scope? track(String label) {
    final scope = _Scope._(label);
    final store = trackState(
      library: 'riverpod',
      label: label,
      via: 'observer',
      actions: true,
      read: () => scope.values,
    );
    if (store == null) return null;
    return scope..store = store;
  }

  final String label;
  late final CapybaraStateStore store;
  // A provider disposed and read again keeps its name; only another provider with the same name gets a number.
  final Expando<String> _names = Expando('capybara.riverpod.names');
  final Map<String, int> _taken = {};

  // Replaced, never changed in place, so the diff skips the providers that did not change.
  Map<String, Object?> values = const {};

  void set(ProviderBase<Object?> provider, Object? value) {
    final name = _name(provider);
    values = {...values, name: _shown(value)};
    store.record(values, action: name);
  }

  void remove(ProviderBase<Object?> provider) {
    final name = _names[provider];
    // Riverpod may report one disposal twice, as when a dependency is invalidated after it.
    if (name == null || !values.containsKey(name)) return;
    values = {...values}..remove(name);
    store.record(values, action: '$name disposed');
  }

  String _name(ProviderBase<Object?> provider) {
    final known = _names[provider];
    if (known != null) return known;
    final base = provider.name ?? '${provider.runtimeType}';
    final argument = provider.argument;
    final name = argument == null ? base : '$base($argument)';
    final n = (_taken[name] ?? 0) + 1;
    _taken[name] = n;
    return _names[provider] = n == 1 ? name : '$name #$n';
  }

  static Object? _shown(Object? value) => switch (value) {
    AsyncData(:final value) => {'data': value},
    AsyncError(:final error) => {'error': '$error'},
    AsyncLoading(:final value, :final hasValue) => {'loading': true, if (hasValue) 'data': value},
    _ => value,
  };
}
