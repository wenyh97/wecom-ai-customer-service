export class FastAPIAIClient {
  constructor({ baseUrl, endpointPath, authToken, staffUserid, timeoutMs = 10000 }) {
    this.baseUrl = (baseUrl || 'http://localhost:8000').replace(/\/$/, '')
    this.endpointPath = endpointPath || '/chat/messages'
    this.authToken = authToken || ''
    this.staffUserid = staffUserid
    this.timeoutMs = timeoutMs
  }

  async generateReply({ conversationId, messageId, content }) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}${this.endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { 'X-WorkPro-Bridge-Token': this.authToken } : {}),
        },
        body: JSON.stringify({
          customer_external_userid: conversationId,
          staff_userid: this.staffUserid,
          content,
          idempotency_key: messageId,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`chat endpoint returned ${response.status}`)
      }

      const payload = await response.json()
      const reply = typeof payload?.reply === 'string' ? payload.reply.trim() : ''
      return reply || null
    } finally {
      clearTimeout(timeout)
    }
  }
}
