export const history = {
  'history.commitCount.one': '{{count}} commit',
  'history.commitCount.other': '{{count}} commits',
} satisfies Record<keyof typeof import('../zh/history').history, string>
