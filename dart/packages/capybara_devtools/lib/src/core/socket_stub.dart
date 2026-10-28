import 'socket.dart';

/// Apps on the web are not read by this package yet; it only has to compile there.
Future<CapybaraSocket> connectSocket(Uri url) => Future.error(UnsupportedError('Capybara does not run on the web yet'));
