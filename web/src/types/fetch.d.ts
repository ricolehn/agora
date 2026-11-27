// What a response's body parses to is not known until the reader says so: unknown instead of the DOM types' any, so
// every answer the app reads from fetch() gets a type of its own (as with apiJson).
interface Body {
  json(): Promise<unknown>;
}

// The same for JSON.parse: what a text holds is unknown until the reader says what it expects
interface JSON {
  parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown;
}
