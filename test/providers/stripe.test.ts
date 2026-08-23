import { describe, expect, it } from 'vitest'
import { stripeProvider } from '../../src/adapters/providers/stripe.ts'
import { fakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

const stripe = stripeProvider()

function ctx(upstream: FakeUpstream) {
  return {
    workspaceId: 'ws-1',
    requestId: 'req-1',
    accessToken: 'rk_test_secret',
    fetch: upstream.fetch,
  }
}

const listOf = (count: number, hasMore: boolean) => ({
  object: 'list',
  url: '/v1/customers',
  has_more: hasMore,
  data: Array.from({ length: count }, (_unused, index) => ({ id: `cus_${index}` })),
})

describe('stripe conformance', () => {
  runAdapterConformance(stripe, {
    pagedTool: 'list_customers',
    fullPage: { args: {}, upstream: fakeUpstream([{ match: /customers/, body: listOf(25, true) }]) },
    lastPage: { args: {}, upstream: fakeUpstream([{ match: /customers/, body: listOf(3, false) }]) },
  })
})

describe('stripe', () => {
  it('believes has_more rather than counting a full page', async () => {
    // The reason this manifest sets hasMorePath. A last page of exactly 25 is
    // the case where counting is wrong, and Stripe's default page is 10, so it
    // is not a rare shape.
    const upstream = fakeUpstream([{ match: /customers/, body: listOf(25, false) }])
    const result = await stripe.callTool(ctx(upstream), 'list_customers', {})
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('pages by the id of the last object, which is what starting_after takes', async () => {
    const upstream = fakeUpstream([{ match: /customers/, body: listOf(25, true) }])
    const result = await stripe.callTool(ctx(upstream), 'list_customers', {})
    expect(result.nextCursor).toBe('cus_24')

    const second = fakeUpstream([{ match: /customers/, body: listOf(1, false) }])
    await stripe.callTool(ctx(second), 'list_customers', { cursor: 'cus_24' })
    const params = new URL(second.calls[0]?.url ?? '').searchParams
    expect(params.get('starting_after')).toBe('cus_24')
    expect(params.get('limit')).toBe('25')
  })

  it('sends the filters under the names Stripe documents, brackets and all', async () => {
    const upstream = fakeUpstream([{ match: /charges/, body: { has_more: false, data: [] } }])
    await stripe.callTool(ctx(upstream), 'list_charges', {
      customer: 'cus_1',
      payment_intent: 'pi_1',
      transfer_group: 'group_a',
      created_after: 1679090000,
      created_before: 1679099999,
    })
    const params = new URL(upstream.calls[0]?.url ?? '').searchParams
    expect(params.get('customer')).toBe('cus_1')
    expect(params.get('payment_intent')).toBe('pi_1')
    expect(params.get('transfer_group')).toBe('group_a')
    // Stripe documents the range as created.gte and takes it form encoded as
    // created[gte]. Getting this wrong is silent: the filter is ignored and the
    // answer looks fine.
    expect(params.get('created[gte]')).toBe('1679090000')
    expect(params.get('created[lte]')).toBe('1679099999')
  })

  it('leaves out a filter the caller did not set, rather than sending an empty one', async () => {
    const upstream = fakeUpstream([{ match: /customers/, body: { has_more: false, data: [] } }])
    await stripe.callTool(ctx(upstream), 'list_customers', { email: 'a@b.test' })
    const url = upstream.calls[0]?.url ?? ''
    expect(new URL(url).searchParams.get('email')).toBe('a@b.test')
    expect(url).not.toContain('created')
  })

  it('keeps the ten fields worth reading out of a fifty field charge', async () => {
    const upstream = fakeUpstream([
      {
        match: /charges/,
        body: {
          id: 'ch_1',
          amount: 1099,
          currency: 'usd',
          status: 'succeeded',
          paid: true,
          refunded: false,
          created: 1679090539,
          description: null,
          customer: null,
          receipt_url: 'https://pay.stripe.test/receipts/x',
          failure_message: null,
          outcome: { seller_message: 'Payment complete.', risk_score: 32, network_status: 'ok' },
          statement_descriptor_suffix: null,
          transfer_group: null,
          calculated_statement_descriptor: 'Stripe',
          payment_method_details: { card: { last4: '4242', fingerprint: 'mToisGZ01V71BCos' } },
        },
      },
    ])
    const result = await stripe.callTool(ctx(upstream), 'get_charge', { charge_id: 'ch_1' })
    expect(result.content).toEqual({
      id: 'ch_1',
      amount: 1099,
      currency: 'usd',
      status: 'succeeded',
      paid: true,
      refunded: false,
      created: 1679090539,
      description: null,
      customer: null,
      receipt_url: 'https://pay.stripe.test/receipts/x',
      failure_message: null,
      outcome: { seller_message: 'Payment complete.' },
    })
    // A card fingerprint has no business reaching a model.
    expect(JSON.stringify(result.content)).not.toContain('fingerprint')
  })

  it('sends the key as a bearer, and reads 403 as a permission problem', async () => {
    const upstream = fakeUpstream([{ match: /customers/, body: listOf(1, false) }])
    await stripe.callTool(ctx(upstream), 'list_customers', {})
    const headers = upstream.calls[0]?.init?.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer rk_test_secret')

    // Stripe's 403 is a key without permission, which reconnecting cannot fix,
    // so it must not be reported as a broken credential.
    const denied = fakeUpstream([{ match: /customers/, status: 403, body: { error: {} } }])
    await expect(stripe.callTool(ctx(denied), 'list_customers', {})).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })
})
