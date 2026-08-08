import { describe } from 'vitest'
import { fakeProvider } from '../../src/adapters/providers/fake.ts'
import { fakeUpstream } from '../helpers/fake-upstream.ts'
import { runAdapterConformance } from '../conformance/adapter.ts'

// The fake serves its own pages, so the upstream double is never called; the
// last page is reached by asking for the second one.
const noUpstream = fakeUpstream([])

describe('fake provider conformance', () => {
  runAdapterConformance(fakeProvider(), {
    pagedTool: 'list_items',
    fullPage: { args: {}, upstream: noUpstream },
    lastPage: { args: { cursor: '2' }, upstream: noUpstream },
  })
})
