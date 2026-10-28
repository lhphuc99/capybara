import '../core/serialize.dart';
import 'engine.dart';

const int _maxStores = 100;
const int _maxTwins = 3;
const SerializeOptions _payloadPreview = SerializeOptions(
  maxDepth: 3,
  maxKeys: 20,
  maxItems: 20,
  maxString: 200,
  maxNodes: 200,
);

/// A store whose state Capybara records, as the packages for Riverpod and Bloc register them.
abstract interface class CapybaraStateStore {
  String get id;

  /// The state changed. [action] names what changed it, such as an event's type, and [payload] is shown with it.
  /// [cause] is `action`, `set` (no action), or `init` for the state a store starts with.
  void record(Object? state, {String? action, Object? payload, String? cause});

  /// The store is gone, as a bloc is once closed.
  void dispose({String? note});
}

final class _Store implements CapybaraStateStore {
  _Store(this._registry, this.id, this.info, this.read);

  final StateRegistry _registry;

  @override
  final String id;

  final Map<String, Object?> info;
  final Object? Function() read;
  bool disposed = false;

  @override
  void record(Object? state, {String? action, Object? payload, String? cause}) {
    if (disposed) return;
    try {
      _registry._engine?.record(
        id,
        state,
        action: action == null
            ? null
            : {'type': action, if (payload != null) 'payload': serialize(payload, _payloadPreview)},
        cause: cause,
      );
    } catch (_) {
      // Never throw into the app's store.
    }
  }

  @override
  void dispose({String? note}) => _registry._dispose(id, note: note);
}

/// The stores registered while the app runs, kept across reconnects; the engine of the running client records them.
final class StateRegistry {
  StateRegistry._();

  static final StateRegistry instance = StateRegistry._();

  final Map<String, _Store> _stores = {};
  final Map<String, int> _counts = {};
  StateEngine? _engine;

  CapybaraStateStore track({
    required String library,
    required String label,
    required String via,
    required bool actions,
    required Object? Function() read,
    String? note,
  }) {
    final twins = [
      for (final store in _stores.values)
        if (store.info['library'] == library && store.info['label'] == label) store.id,
    ];
    // The same store made again and again, as a screen's bloc, keeps only its latest few.
    for (final id in twins.take(twins.length - (_maxTwins - 1) < 0 ? 0 : twins.length - (_maxTwins - 1))) {
      _dispose(id);
    }
    while (_stores.length >= _maxStores) {
      _dispose(_stores.keys.first, note: 'Dropped to stay under $_maxStores stores');
    }
    final n = (_counts[library] ?? 0) + 1;
    _counts[library] = n;
    final id = '$library:$n';
    final store = _Store(this, id, {
      'library': library,
      'label': label,
      'via': via,
      'actions': actions,
      'note': ?note,
    }, read);
    _stores[id] = store;
    _engine?.track(id, store.info, read);
    return store;
  }

  void attach(StateEngine engine) {
    _engine = engine;
    for (final store in _stores.values) {
      engine.track(store.id, store.info, store.read);
    }
  }

  void detach(StateEngine engine) {
    if (identical(_engine, engine)) _engine = null;
  }

  void _dispose(String id, {String? note}) {
    final store = _stores.remove(id);
    if (store == null) return;
    store.disposed = true;
    _engine?.untrack(id, note: note);
  }
}
