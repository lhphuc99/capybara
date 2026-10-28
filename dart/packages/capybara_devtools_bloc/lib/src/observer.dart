import 'package:bloc/bloc.dart';
import 'package:capybara_devtools/adapter.dart';

/// Shows each bloc and cubit in Capybara's State tab: one store per instance, a bloc's changes named after the event
/// that made them. Pass the observer the app had, so it keeps working:
///
/// ```dart
/// Bloc.observer = CapybaraBlocObserver(parent: Bloc.observer);
/// ```
class CapybaraBlocObserver extends BlocObserver {
  CapybaraBlocObserver({BlocObserver? parent}) : _parent = parent;

  final BlocObserver? _parent;
  final Expando<CapybaraStateStore> _stores = Expando('capybara.bloc');

  // The parent's hooks are protected, meant for subclasses; passing calls on to another observer is what
  // bloc's own MultiBlocObserver does.
  // ignore_for_file: invalid_use_of_protected_member

  @override
  void onCreate(BlocBase<dynamic> bloc) {
    super.onCreate(bloc);
    _parent?.onCreate(bloc);
    final store = trackState(
      library: 'bloc',
      label: '${bloc.runtimeType}',
      via: 'observer',
      actions: bloc is Bloc,
      read: () => bloc.state,
    );
    if (store == null) return;
    _stores[bloc] = store;
    store.record(bloc.state, cause: 'init');
  }

  @override
  void onEvent(Bloc<dynamic, dynamic> bloc, Object? event) {
    super.onEvent(bloc, event);
    _parent?.onEvent(bloc, event);
  }

  @override
  void onTransition(Bloc<dynamic, dynamic> bloc, Transition<dynamic, dynamic> transition) {
    super.onTransition(bloc, transition);
    _parent?.onTransition(bloc, transition);
    final event = transition.event;
    _stores[bloc]?.record(
      transition.nextState,
      action: '${event.runtimeType}',
      // An event with nothing to show prints as "Instance of …", which says no more than its type.
      payload: '$event'.startsWith('Instance of ') ? null : event,
    );
  }

  @override
  void onChange(BlocBase<dynamic> bloc, Change<dynamic> change) {
    super.onChange(bloc, change);
    _parent?.onChange(bloc, change);
    // A bloc's changes arrive with their event in onTransition.
    if (bloc is! Bloc) _stores[bloc]?.record(change.nextState);
  }

  @override
  void onError(BlocBase<dynamic> bloc, Object error, StackTrace stackTrace) {
    super.onError(bloc, error, stackTrace);
    _parent?.onError(bloc, error, stackTrace);
  }

  @override
  void onClose(BlocBase<dynamic> bloc) {
    super.onClose(bloc);
    _parent?.onClose(bloc);
    _stores[bloc]?.dispose(note: 'Closed');
  }
}
