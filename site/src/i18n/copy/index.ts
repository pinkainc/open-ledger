import type { Lang } from '../ui';
import type { Copy } from './types';
import { en } from './en';
import { hr } from './hr';

export const copy: Record<Lang, Copy> = { en, hr };
export { text, levelKey } from './types';
export type { Copy, Facts, Text } from './types';
