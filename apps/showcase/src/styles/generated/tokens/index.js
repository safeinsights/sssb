import { colorMix, toCssVar } from '../helpers';

const tokens = {}

const resolveVar = toCssVar

export const token = /* @__PURE__ */ Object.assign(
  function token(path, fallback) {
    const value = tokens[path]
    return value === undefined ? colorMix(tokens, path, resolveVar) || fallback : value || resolveVar(path)
  },
  {
    var: function tokenVar(path, fallback) {
      return tokens[path] === undefined ? fallback : resolveVar(path)
    },
  },
)