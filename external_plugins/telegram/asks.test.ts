import { describe, expect, test } from 'bun:test'
import { askOwner, NO_ASKS, ownerAnswers } from './asks.ts'

describe('who gets and answers a permission prompt', () => {
  test('the owner, whose private chat is the owner chat', () => {
    expect(askOwner('64024129')).toBe('64024129')
    expect(ownerAnswers('64024129', { id: 64024129 })).toBe(true)
  })

  test('no one else on the allowlist, a person or another bot', () => {
    expect(ownerAnswers('64024129', { id: 5 })).toBe(false)
    expect(ownerAnswers('64024129', { id: 8606571973 })).toBe(false)
    expect(ownerAnswers('64024129', undefined)).toBe(false)
  })

  test('no one without an owner chat', () => {
    expect(askOwner(undefined)).toBeUndefined()
    expect(ownerAnswers(undefined, { id: 64024129 })).toBe(false)
  })

  test('no one when the owner chat is a group, which names no user', () => {
    expect(askOwner('-1001234')).toBeUndefined()
    expect(ownerAnswers('-1001234', { id: -1001234 })).toBe(false)
    expect(ownerAnswers('-1001234', { id: 1001234 })).toBe(false)
  })

  test('the warning names where a prompt is still answered', () => {
    expect(NO_ASKS).toBe('permission prompts are answered only in the terminal')
  })
})
