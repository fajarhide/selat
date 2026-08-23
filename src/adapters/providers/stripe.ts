import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

// A charge carries about fifty top-level fields and a customer about twenty,
// so every tool here projects. Without it one page of twenty charges is most of
// a context window spent on statement descriptors and transfer groups.
const CUSTOMER_FIELDS = [
  'id',
  'email',
  'name',
  'description',
  'created',
  'currency',
  'balance',
  'delinquent',
]

const CHARGE_FIELDS = [
  'id',
  'amount',
  'currency',
  'status',
  'paid',
  'refunded',
  'created',
  'description',
  'customer',
  'receipt_url',
]

// Stripe filters a date range through a nested parameter, documented as
// created.gte and sent form encoded as created[gte]. Declared as two flat
// arguments because an agent handles two integers better than one object, and
// because ArgDef has no object type.
const CREATED_RANGE = {
  created_after: {
    type: 'number',
    description: 'Unix seconds. Only objects created at or after this',
    param: 'created[gte]',
  },
  created_before: {
    type: 'number',
    description: 'Unix seconds. Only objects created at or before this',
    param: 'created[lte]',
  },
} as const

export const stripeManifest: ProviderManifest = {
  id: 'stripe',
  prefix: 'stripe',
  maturity: 'experimental',
  baseUrl: 'https://api.stripe.com',
  scopes: [],
  // A restricted key is what a workspace should bring. Stripe takes it as a
  // bearer, so this is api_key rather than oauth: there is no application
  // behind it, only a secret each workspace supplies.
  auth: { type: 'api_key', in: 'header', name: 'authorization', prefix: 'Bearer ' },
  // starting_after takes the id of the last object seen, not an opaque token,
  // and the list envelope states outright whether more exist. Without has_more
  // a last page of exactly `size` items would be reported as having a next one.
  pagination: {
    style: 'id',
    size: 25,
    sizeParam: 'limit',
    param: 'starting_after',
    hasMorePath: 'has_more',
  },
  errors: {
    // Stripe's 403 is "the API key doesn't have permissions", which reconnecting
    // does not fix. Only 401 means no valid key.
    forbidden: 'upstream_error',
  },
  tools: [
    {
      name: 'list_customers',
      description: 'List customers, most recently created first',
      write: false,
      request: 'GET /v1/customers',
      args: {
        email: {
          type: 'string',
          description: 'Exact match on the customer email, and case sensitive',
        },
        ...CREATED_RANGE,
      },
      items: 'data',
      fields: CUSTOMER_FIELDS,
    },
    {
      name: 'get_customer',
      description: 'Fetch one customer by id',
      write: false,
      request: 'GET /v1/customers/{customer_id}',
      args: { customer_id: { type: 'string', required: true } },
      fields: CUSTOMER_FIELDS,
    },
    {
      name: 'list_charges',
      description: 'List charges, most recently created first',
      write: false,
      request: 'GET /v1/charges',
      args: {
        customer: { type: 'string', description: 'Only charges for this customer id' },
        payment_intent: { type: 'string', description: 'Only charges from this PaymentIntent' },
        transfer_group: { type: 'string', description: 'Only charges in this transfer group' },
        ...CREATED_RANGE,
      },
      items: 'data',
      fields: CHARGE_FIELDS,
    },
    {
      name: 'get_charge',
      description: 'Fetch one charge by id, with why it failed if it did',
      write: false,
      request: 'GET /v1/charges/{charge_id}',
      args: { charge_id: { type: 'string', required: true } },
      // outcome.seller_message is the sentence that explains a decline, and it
      // is the reason to fetch one charge rather than read it off a list.
      fields: [...CHARGE_FIELDS, 'failure_message', 'outcome.seller_message'],
    },
  ],
}

export function stripeProvider(): ProviderAdapter {
  return manifestProvider(stripeManifest)
}
