import 'dart:async';

/// What the client needs of a WebSocket to the Capybara server.
abstract interface class CapybaraSocket {
  /// Text frames from the server; done when the socket closes.
  Stream<String> get messages;

  void send(String data);

  Future<void> close();
}

/// Opens a socket, or throws when the server cannot be reached.
typedef SocketConnector = Future<CapybaraSocket> Function(Uri url);

/// A connection the app's setup refuses, with what the developer can change. The client tells it once.
final class CapybaraSetupError implements Exception {
  const CapybaraSetupError(this.message);

  final String message;

  @override
  String toString() => message;
}
