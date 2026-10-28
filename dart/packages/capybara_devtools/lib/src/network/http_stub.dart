/// Without dart:io there is no HttpClient to record.
({void Function() check, void Function() remove}) installHttpOverrides() => (check: () {}, remove: () {});

bool isIoClient(Object client) => false;
