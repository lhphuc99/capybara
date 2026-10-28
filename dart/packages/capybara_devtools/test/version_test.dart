@TestOn('vm')
library;

import 'dart:io';

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the version the package reports is the one it is published as', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final version = RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)!.group(1);
    expect(capybaraVersion, version);
  });
}
