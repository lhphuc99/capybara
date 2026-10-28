import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:capybara_devtools_riverpod/capybara_devtools_riverpod.dart';
import 'package:flutter/material.dart';
import 'package:riverpod/riverpod.dart';

final class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new, name: 'counter');

void main() {
  Capybara.run(() {
    WidgetsFlutterBinding.ensureInitialized();
    final container = ProviderContainer(observers: const [CapybaraRiverpodObserver()]);
    runApp(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: FilledButton(
              onPressed: () => container.read(counterProvider.notifier).increment(),
              child: const Text('Count'),
            ),
          ),
        ),
      ),
    );
  });
}
