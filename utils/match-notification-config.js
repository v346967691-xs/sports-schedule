module.exports = {
  templates: {
    kickoff: '6DSxxuaVZBvjGQ9-J52kJ6-4r1XG98zDoE7SXCAtAX0',
    result: 'uTwK8vI2uN18Lfj9UzbBM4zRcz_gy8BjZVBHJfqKQSQ',
  },
  templateId(kind) { return kind === 'result' ? this.templates.result : this.templates.kickoff },
  kindsFor(match, now = Date.now()) {
    if (!match || !match.comp || !Date.parse(match.start || '')) return []
    if (match.status === 'upcoming') return Date.parse(match.start) > now ? ['pre15', 'result'] : ['result']
    if (match.status === 'live') return ['result']
    return []
  },
  isConfigured() { return !!this.templates.kickoff && !!this.templates.result },
}
