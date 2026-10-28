import 'package:capybara_example/actions.dart';
import 'package:capybara_example/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows a button for each action', (tester) async {
    // ListView builds only what fits, so the view is made tall enough for every button.
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1200, 6000);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const ExampleApp());

    expect(find.text('Capybara example'), findsOneWidget);
    expect(find.byType(OutlinedButton), findsNWidgets(actions.length));
  });

  test('every action has an id the tools can name', () {
    expect(actions.keys, everyElement(matches(RegExp(r'^[a-z]+(\.[A-Za-z0-9]+)+$'))));
    expect(actions, contains('http.dio.get10k'));
  });
}
