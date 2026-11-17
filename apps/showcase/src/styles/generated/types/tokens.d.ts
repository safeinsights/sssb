import type { Registered } from './register';

export type Token = Registered<"Token", string>

export type ColorOpacityModifier = Registered<"ColorOpacityModifier", `${number}`>

export type ColorOpacityToken = Registered<"ColorOpacityToken", never>

interface LocalTokens {}

export interface Tokens extends Registered<"Tokens", LocalTokens> {}

export type TokenPath = Token | ColorOpacityToken

export type ColorPalette = Registered<"ColorPalette", string>

export type TokenValue<T extends string> = T extends keyof Tokens ? Tokens[T] : never