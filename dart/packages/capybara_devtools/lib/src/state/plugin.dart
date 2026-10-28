import '../core/client.dart';
import 'engine.dart';
import 'registry.dart';

/// The `state` plugin: records the stores in [StateRegistry] while the client runs, and answers reads by path.
final class StatePlugin extends CapybaraPlugin {
  StateEngine? _engine;

  @override
  String get name => 'state';

  @override
  void Function()? setup(PluginContext context) {
    final engine = StateEngine(context.emit, connected: () => context.connected);
    _engine = engine;
    StateRegistry.instance.attach(engine);
    return () {
      StateRegistry.instance.detach(engine);
      engine.dispose();
      _engine = null;
    };
  }

  StateEngine get _running => _engine ?? (throw StateError('Capybara is not running'));

  static String _store(Object? params) => '${(params! as Map)['store']}';

  @override
  Map<String, CommandHandler> get commands => {
    'stores': (_) => _running.stores(),
    'get': (params) {
      final path = (params! as Map)['path'];
      return _running.read(_store(params), path is List ? path.cast<Object?>() : const []);
    },
    // Stores of Flutter apps hold one state each; none has cache entries as TanStack Query's.
    'entries': (params) => throw StateError('${_running.label(_store(params))} has no entries'),
    'entry': (params) => throw StateError('${_running.label(_store(params))} has no entries'),
    'act': (params) =>
        throw StateError('${_running.label(_store(params))} does not support "${(params! as Map)['op']}"'),
  };
}
