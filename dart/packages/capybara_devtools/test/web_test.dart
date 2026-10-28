@TestOn('browser')
library;

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('on the web, runs the app and nothing else', () {
    var ran = false;
    Capybara.run(() => ran = true);
    Capybara.init();
    Capybara.log('nowhere');
    expect(ran, isTrue);
    expect(Capybara.client, isNull);
  });
}
