// Computes richParts off the server's thread. See richPartsAsync in rich.ts.
import { richParts } from './rich.ts'

declare var self: Worker

self.onmessage = (e: MessageEvent) => {
  const { id, text, limits } = e.data
  try {
    postMessage({ id, parts: richParts(text, limits) })
  } catch (err) {
    postMessage({ id, error: String(err) })
  }
}

postMessage({ loaded: true })
