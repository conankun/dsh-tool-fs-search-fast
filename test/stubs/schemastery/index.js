// Minimal schemastery stand-in for local unit tests: enough to exercise the
// plugin's Config defaults without the real schema engine.
const make = (kind) => ({
  kind,
  def: void 0,
  required() { return { kind, required: true }; },
  default(value) { return { kind, def: value }; }
});

const z = {
  object: (shape) => {
    const parse = (input) => {
      const source = input ?? {};
      const out = {};
      for (const [key, spec] of Object.entries(shape)) {
        const value = source[key] !== void 0 ? source[key] : spec?.def;
        if (value !== void 0) out[key] = value;
      }
      return out;
    };
    parse.kind = "object";
    parse.shape = shape;
    return parse;
  },
  string: () => make("string"),
  number: () => make("number"),
  boolean: () => make("boolean"),
  array: (inner) => make("array")
};
export default z;
