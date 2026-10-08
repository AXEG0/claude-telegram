// Computes richParts off the server's thread. See richPartsAsync in rich.ts.
import { richParts } from './rich.ts'

declare var self: Worker

self.onmessage = (e: MessageEvent) => {
  try {
    postMessage({ parts: richParts(e.data.text, e.data.limits) })
  } catch (err) {
    postMessage({ error: String(err) })
  }
}
