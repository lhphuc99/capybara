import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter/material.dart';

void main() {
  Capybara.run(() {
    WidgetsFlutterBinding.ensureInitialized();
    runApp(const ExampleApp());
  }, options: const CapybaraOptions(appName: 'Example'));
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: Center(
          child: FilledButton(
            onPressed: () => Capybara.log('Cart saved', level: 'info', data: {'items': 3, 'total': 42.5}),
            child: const Text('Log a value'),
          ),
        ),
      ),
    );
  }
}
