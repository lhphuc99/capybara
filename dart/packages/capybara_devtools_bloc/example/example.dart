import 'package:bloc/bloc.dart';
import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:capybara_devtools_bloc/capybara_devtools_bloc.dart';
import 'package:flutter/material.dart';

final class CounterCubit extends Cubit<int> {
  CounterCubit() : super(0);

  void increment() => emit(state + 1);
}

void main() {
  Capybara.run(() {
    WidgetsFlutterBinding.ensureInitialized();
    Bloc.observer = CapybaraBlocObserver(parent: Bloc.observer);
    final counter = CounterCubit();
    runApp(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: FilledButton(onPressed: counter.increment, child: const Text('Count')),
          ),
        ),
      ),
    );
  });
}
