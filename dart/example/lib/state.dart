import 'package:bloc/bloc.dart';
import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:capybara_devtools_bloc/capybara_devtools_bloc.dart';
import 'package:capybara_devtools_riverpod/capybara_devtools_riverpod.dart';
import 'package:flutter/foundation.dart';
import 'package:riverpod/riverpod.dart';

/// State for the State tab: a Riverpod counter and cart, a Bloc, a Cubit and a watched ChangeNotifier. The app has
/// no screen for them; their buttons change them.
final class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new, name: 'counter');

final cartTotalProvider = FutureProvider<double>((ref) async {
  await Future<void>.delayed(const Duration(milliseconds: 300));
  return 12.5 * ref.watch(counterProvider);
}, name: 'cartTotal');

final providers = ProviderContainer(observers: const [CapybaraRiverpodObserver()]);

sealed class CartEvent {}

final class ItemAdded extends CartEvent {
  ItemAdded(this.sku, this.qty);

  final String sku;
  final int qty;

  Map<String, Object?> toJson() => {'sku': sku, 'qty': qty};
}

final class CartCleared extends CartEvent {}

final class CartBloc extends Bloc<CartEvent, Map<String, int>> {
  CartBloc() : super(const {}) {
    on<ItemAdded>((event, emit) => emit({...state, event.sku: (state[event.sku] ?? 0) + event.qty}));
    on<CartCleared>((event, emit) => emit(const {}));
  }
}

final class ThemeCubit extends Cubit<String> {
  ThemeCubit() : super('light');

  void toggle() => emit(state == 'light' ? 'dark' : 'light');
}

final class Settings extends ChangeNotifier {
  bool notifications = true;
  double volume = 0.8;

  void change() {
    notifications = !notifications;
    volume = notifications ? 0.8 : 0.2;
    notifyListeners();
  }

  Map<String, Object?> toJson() => {'notifications': notifications, 'volume': volume};
}

late final CartBloc cart;
late final ThemeCubit theme;
final settings = Settings();

/// Puts Capybara's Bloc observer in front of the app's, and makes the stores the buttons change.
void setUpState() {
  Bloc.observer = CapybaraBlocObserver(parent: Bloc.observer);
  cart = CartBloc();
  theme = ThemeCubit();
  Capybara.watch('settings', settings);
  providers.read(counterProvider);
}
