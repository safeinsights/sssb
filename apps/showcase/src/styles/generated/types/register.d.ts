import type { Conditions, Breakpoints, ContainerName, SystemProperties } from './system';
import type { Tokens, Token, ColorOpacityModifier, ColorOpacityToken, ColorPalette } from './tokens';

export interface Register {}

export type Registered<K extends PropertyKey, Local> = Register extends { system: infer System }
  ? K extends keyof System
    ? System[K]
    : Local
  : Local

export interface PandaSystem {
  Conditions: Conditions
  Breakpoints: Breakpoints
  ContainerName: ContainerName
  SystemProperties: SystemProperties
  Tokens: Tokens
  Token: Token
  ColorOpacityModifier: ColorOpacityModifier
  ColorOpacityToken: ColorOpacityToken
  ColorPalette: ColorPalette
}