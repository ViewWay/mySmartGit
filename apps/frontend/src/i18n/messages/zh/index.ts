import { common } from './common'
import { diff } from './diff'
import { errors } from './errors'
import { history } from './history'
import { menu } from './menu'
import { nav } from './nav'
import { operation } from './operation'
import { preferences } from './preferences'
import { repository } from './repository'
import { review } from './review'
import { settings } from './settings'
import { stage } from './stage'
import { tools } from './tools'
import { updates } from './updates'

export const zh = {
  ...common,
  ...nav,
  ...history,
  ...diff,
  ...stage,
  ...operation,
  ...repository,
  ...review,
  ...tools,
  ...settings,
  ...preferences,
  ...updates,
  ...errors,
  ...menu,
}

export type MessageKey = keyof typeof zh
