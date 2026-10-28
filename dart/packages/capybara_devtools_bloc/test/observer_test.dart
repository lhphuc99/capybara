import 'package:bloc/bloc.dart';
import 'package:capybara_devtools/adapter.dart';
import 'package:capybara_devtools_bloc/capybara_devtools_bloc.dart';
import 'package:flutter_test/flutter_test.dart';

final class _Theme extends Cubit<String> {
  _Theme() : super('light');

  void toggle() => emit(state == 'light' ? 'dark' : 'light');
}

sealed class _CartEvent {}

final class _Added extends _CartEvent {
  _Added(this.item);

  final String item;

  @override
  String toString() => 'Added($item)';
}

final class _Cleared extends _CartEvent {}

final class _Cart extends Bloc<_CartEvent, List<String>> {
  _Cart() : super(const []) {
    on<_Added>((event, emit) => emit([...state, event.item]));
    on<_Cleared>((event, emit) => emit(const []));
  }
}

final class _Seen extends BlocObserver {
  final List<String> calls = [];

  @override
  void onCreate(BlocBase<dynamic> bloc) {
    super.onCreate(bloc);
    calls.add('create ${bloc.runtimeType}');
  }

  @override
  void onClose(BlocBase<dynamic> bloc) {
    super.onClose(bloc);
    calls.add('close ${bloc.runtimeType}');
  }
}

void main() {
  late List<(String, Map<String, Object?>)> events;
  late void Function() detach;
  late _Seen app;

  setUp(() {
    events = [];
    detach = debugAttachStateEngine((kind, payload) => events.add((kind, payload)));
    app = _Seen();
    Bloc.observer = CapybaraBlocObserver(parent: app);
  });

  tearDown(() => detach());

  Future<void> flushed() => Future<void>.delayed(const Duration(milliseconds: 150));

  List<Map<String, Object?>> changes(String store) => [
    for (final (kind, payload) in events)
      if (kind == 'state.change' && payload['store'] == store) payload,
  ];

  Map<String, Object?> storeNamed(String label) => events
      .where((event) => event.$1 == 'state.store')
      .map((event) => event.$2['store']! as Map<String, Object?>)
      .lastWhere((store) => store['label'] == label);

  test('records a bloc: its first state, and each change named after its event', () async {
    final cart = _Cart()
      ..add(_Added('tea'))
      ..add(_Cleared());
    await flushed();
    final store = storeNamed('_Cart');
    expect(store['library'], 'bloc');
    expect(store['actions'], isTrue);
    final recorded = changes(store['id']! as String);
    expect([for (final change in recorded) change['cause']], ['init', 'action', 'action']);
    expect(recorded[1]['action'], {
      'type': '_Added',
      'payload': {r'$t': 'node', 'v': 'Added(tea)'},
    });
    expect(recorded[2]['action'], {'type': '_Cleared'});
    expect(recorded[1]['ops'], [
      {
        'op': 'add',
        'path': [0],
        'value': 'tea',
      },
    ]);
    await cart.close();
    expect(storeNamed('_Cart')['disposed'], isTrue);
    expect(app.calls, ['create _Cart', 'close _Cart']);
  });

  test('records a cubit without action names', () async {
    final theme = _Theme()..toggle();
    await flushed();
    final store = storeNamed('_Theme');
    expect(store['actions'], isFalse);
    final recorded = changes(store['id']! as String);
    expect([for (final change in recorded) change['cause']], ['init', 'set']);
    expect(recorded.last['ops'], [
      {'op': 'set', 'path': <Object>[], 'value': 'dark', 'prev': 'light'},
    ]);
    await theme.close();
  });
}
