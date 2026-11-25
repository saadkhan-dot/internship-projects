import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidPersonName, isValidDesignation, splitUnambiguousName } from '../src/extraction/normalization.js'
import { parseHtmlPage } from '../src/extraction/pageParser.js'
import { extractCandidates } from '../src/extraction/candidateExtractor.js'

test('Phase 1 - Task 1: Name validation rejects generic website headings, CTAs, policies, and departments', () => {
  const invalidNames = [
    'Contact Us',
    'About Us',
    'Our Team',
    'Meet Our Team',
    'Leadership Team',
    'Our People',
    'Privacy Policy',
    'Terms of Service',
    'Terms and Conditions',
    'Careers',
    'Get In Touch',
    'Frequently Asked Questions',
    'FAQ',
    'Support',
    'Sales',
    'Marketing',
    'Administration',
    'Customer Support',
    'Technical Support',
    'Human Resources',
    'Billing',
    'General Inquiries',
    'Press',
    'Media',
    'Join Our Team',
    'Work With Us',
    'Who We Are',
    'Our Story',
    'Staff Directory',
    'Board of Directors',
    'Management Team',
    'Marketing Team',
    'Sales Department',
    'Acme LLC',
  ]

  for (const name of invalidNames) {
    assert.equal(
      isValidPersonName(name),
      false,
      `Expected "${name}" to be rejected by isValidPersonName, but it was accepted`
    )
  }
})

test('Phase 1 - Task 1: Name validation accepts legitimate human names', () => {
  const validNames = [
    'Alice Johnson',
    'Sarah Connor',
    'Nell Shamrell-Harrington',
    'John O\'Connor',
    'Mary Jane Watson',
    'Dr. Alan Turing',
    'Li Na',
    'Jean-Luc Picard',
    'Harold Finch',
    'René Descartes',
    'François Hollande',
    'Björn Borg',
  ]

  for (const name of validNames) {
    assert.equal(
      isValidPersonName(name),
      true,
      `Expected "${name}" to be accepted by isValidPersonName, but it was rejected`
    )
  }
})

test('Phase 1 - Task 2: Candidate designation cannot equal extracted person name', () => {
  assert.equal(isValidDesignation('Nell Shamrell-Harrington', 'Nell Shamrell-Harrington'), false)
  assert.equal(isValidDesignation('nell shamrell-harrington', 'Nell Shamrell-Harrington'), false)
  assert.equal(isValidDesignation('Nell Shamrell', 'Nell Shamrell-Harrington'), false)
  assert.equal(isValidDesignation('About Nell Shamrell-Harrington', 'Nell Shamrell-Harrington'), false)
  assert.equal(isValidDesignation('Alice Johnson', 'Alice Johnson'), false)

  // Legitimate designations for the person must pass
  assert.equal(isValidDesignation('Principal Software Engineer', 'Nell Shamrell-Harrington'), true)
  assert.equal(isValidDesignation('Board Member', 'Nell Shamrell-Harrington'), true)
  assert.equal(isValidDesignation('Director of Engineering', 'Alice Johnson'), true)
  assert.equal(isValidDesignation('Chief Executive Officer', 'Sarah Connor'), true)
})

test('Phase 1 - Task 2: Extraction resolves Bug 2 where name in card-title or heading was extracted as designation', () => {
  const html = `
    <html><body>
      <div class="team-section">
        <div class="card">
          <div class="card-body">
            <h4 class="card-title">Nell Shamrell-Harrington</h4>
            <p class="role">Principal Software Engineer</p>
            <a href="mailto:nell@example.com">nell@example.com</a>
            <a href="https://www.linkedin.com/in/nellshamrell">LinkedIn</a>
          </div>
        </div>
      </div>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/team' })
  const person = candidates.find(c => c.candidateType === 'person' && c.fields.full_name === 'Nell Shamrell-Harrington')

  assert.ok(person, 'Nell Shamrell-Harrington must be extracted')
  assert.notEqual(person.fields.designation, 'Nell Shamrell-Harrington', 'Designation must NOT equal person name')
  assert.equal(person.fields.designation, 'Principal Software Engineer', 'Designation must be the legitimate job title')
  assert.equal(person.fields.email, 'nell@example.com')
  assert.equal(person.fields.linkedin_url, 'https://linkedin.com/in/nellshamrell')
})

test('Phase 1 - Task 2: If no legitimate title exists, designation remains null and narrative bios are rejected', () => {
  const html = `
    <html><body>
      <div class="team-grid">
        <div class="member-card">
          <h3>Alice Johnson</h3>
          <p class="bio">Alice is an open-source contributor and enjoys running marathons in her spare time.</p>
          <a href="mailto:alice@example.com">alice@example.com</a>
        </div>
        <div class="member-card">
          <h3>Bob Smith</h3>
          <a href="tel:+15551234567">+1 555-123-4567</a>
        </div>
      </div>
    </body></html>
  `
  const { candidates } = extractCandidates(html, { sourceUrl: 'https://example.com/team' })
  const alice = candidates.find(c => c.fields.full_name === 'Alice Johnson')
  const bob = candidates.find(c => c.fields.full_name === 'Bob Smith')

  assert.ok(alice, 'Alice Johnson must be extracted')
  assert.equal(alice.fields.designation, null, 'Narrative bio text must not be extracted as designation')
  assert.equal(alice.fields.email, 'alice@example.com')

  assert.ok(bob, 'Bob Smith must be extracted')
  assert.equal(bob.fields.designation, null, 'Missing title must remain null')
  assert.ok(bob.fields.phone && bob.fields.phone.includes('5551234567'), 'Phone number must be extracted')
})

test('Phase 1 - Task 3: Profile card detection extracts Drupal views-row structures', () => {
  const drupalHtml = `
    <html><body>
      <div class="view-content">
        <div class="views-row views-row-1 views-row-odd">
          <div class="views-field views-field-title">
            <span class="field-content"><h3>Alice Johnson</h3></span>
          </div>
          <div class="views-field views-field-field-job-title">
            <div class="field-content">VP of Engineering</div>
          </div>
          <div class="views-field views-field-field-email">
            <span class="field-content"><a href="mailto:alice@example.com">alice@example.com</a></span>
          </div>
        </div>
        <div class="views-row views-row-2 views-row-even">
          <div class="views-field views-field-title">
            <span class="field-content"><h3>Bob Smith</h3></span>
          </div>
          <div class="views-field views-field-field-job-title">
            <div class="field-content">Chief Technology Officer</div>
          </div>
          <div class="views-field views-field-field-email">
            <span class="field-content"><a href="mailto:bob@example.com">bob@example.com</a></span>
          </div>
        </div>
      </div>
    </body></html>
  `
  const { candidates } = extractCandidates(drupalHtml, { sourceUrl: 'https://example.com/drupal-team' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 2, 'Should extract 2 person candidates from Drupal views-row directory')

  const alice = people.find(p => p.fields.full_name === 'Alice Johnson')
  assert.ok(alice, 'Alice Johnson must be found in Drupal views-row')
  assert.equal(alice.fields.designation, 'VP of Engineering')
  assert.equal(alice.fields.email, 'alice@example.com')

  const bob = people.find(p => p.fields.full_name === 'Bob Smith')
  assert.ok(bob, 'Bob Smith must be found in Drupal views-row')
  assert.equal(bob.fields.designation, 'Chief Technology Officer')
  assert.equal(bob.fields.email, 'bob@example.com')
})

test('Phase 1 - Task 3: Profile card detection extracts WordPress block-based layouts', () => {
  const wpHtml = `
    <html><body>
      <div class="wp-block-group">
        <div class="wp-block-columns is-layout-flex">
          <div class="wp-block-column">
            <h3 class="wp-block-heading">Sarah Connor</h3>
            <p class="role">Chief Security Officer</p>
            <a href="mailto:sarah@resistance.org">sarah@resistance.org</a>
            <a href="https://www.linkedin.com/in/sarah-connor">LinkedIn</a>
          </div>
          <div class="wp-block-column">
            <h3 class="wp-block-heading">John Reese</h3>
            <p class="role">Operations Lead</p>
            <a href="mailto:john@resistance.org">john@resistance.org</a>
          </div>
        </div>
      </div>
    </body></html>
  `
  const { candidates } = extractCandidates(wpHtml, { sourceUrl: 'https://example.com/wp-team' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 2, 'Should extract 2 person candidates from WordPress block columns')

  const sarah = people.find(p => p.fields.full_name === 'Sarah Connor')
  assert.ok(sarah, 'Sarah Connor must be found in WordPress block')
  assert.equal(sarah.fields.designation, 'Chief Security Officer')
  assert.equal(sarah.fields.email, 'sarah@resistance.org')
  assert.equal(sarah.fields.linkedin_url, 'https://linkedin.com/in/sarah-connor')

  const john = people.find(p => p.fields.full_name === 'John Reese')
  assert.ok(john, 'John Reese must be found in WordPress block')
  assert.equal(john.fields.designation, 'Operations Lead')
  assert.equal(john.fields.email, 'john@resistance.org')
})

test('Phase 1 - Task 3: Profile card detection extracts table row directories', () => {
  const tableHtml = `
    <html><body>
      <table class="staff-directory">
        <thead>
          <tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Mary Jane Watson</strong></td>
            <td>Managing Editor</td>
            <td><a href="mailto:mj@bugle.com">mj@bugle.com</a></td>
            <td>+1 212-555-0199</td>
          </tr>
          <tr>
            <td><strong>Peter Parker</strong></td>
            <td>Staff Photographer</td>
            <td><a href="mailto:peter@bugle.com">peter@bugle.com</a></td>
            <td>+1 212-555-0188</td>
          </tr>
        </tbody>
      </table>
    </body></html>
  `
  const { candidates } = extractCandidates(tableHtml, { sourceUrl: 'https://example.com/staff-table' })
  const people = candidates.filter(c => c.candidateType === 'person')

  assert.equal(people.length, 2, 'Should extract 2 person candidates from staff table')

  const mj = people.find(p => p.fields.full_name === 'Mary Jane Watson')
  assert.ok(mj, 'Mary Jane Watson must be extracted')
  assert.equal(mj.fields.designation, 'Managing Editor')
  assert.equal(mj.fields.email, 'mj@bugle.com')

  const peter = people.find(p => p.fields.full_name === 'Peter Parker')
  assert.ok(peter, 'Peter Parker must be extracted')
  assert.equal(peter.fields.designation, 'Staff Photographer')
  assert.equal(peter.fields.email, 'peter@bugle.com')
})

test('Phase 1 - Task 4: Contact pages containing "Contact Us" do NOT produce false person records', () => {
  const contactPageHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Contact Us - LeadIntel Inc.</title>
    </head>
    <body>
      <main>
        <section class="contact-header">
          <h1>Contact Us</h1>
          <p>Get in touch with our team for sales, support, or general inquiries.</p>
        </section>
        <section class="contact-info">
          <h2>Get In Touch</h2>
          <div class="contact-details">
            <p><strong>Email:</strong> <a href="mailto:info@leadintel.io">info@leadintel.io</a></p>
            <p><strong>Phone:</strong> <a href="tel:+18005550199">+1 (800) 555-0199</a></p>
            <p><strong>Support:</strong> <a href="mailto:support@leadintel.io">support@leadintel.io</a></p>
          </div>
          <div class="office-location">
            <h3>Headquarters</h3>
            <p>100 Market Street, Suite 400, San Francisco, CA 94105</p>
          </div>
        </section>
        <section class="policy-links">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
        </section>
      </main>
    </body>
    </html>
  `

  const { candidates } = extractCandidates(contactPageHtml, { sourceUrl: 'https://leadintel.io/contact' })

  // Ensure NO person candidates are created from "Contact Us", "Get In Touch", etc.
  const people = candidates.filter(c => c.candidateType === 'person')
  assert.equal(people.length, 0, 'Contact Us page must produce ZERO person candidates')

  // Verify no candidate has full_name matching generic headings
  for (const c of candidates) {
    if (c.fields.full_name) {
      assert.notEqual(c.fields.full_name, 'Contact Us')
      assert.notEqual(c.fields.full_name, 'Get In Touch')
      assert.notEqual(c.fields.full_name, 'Privacy Policy')
      assert.notEqual(c.fields.full_name, 'Terms of Service')
    }
  }

  // Verify contact info is still captured as general/unknown candidates
  const emailCandidates = candidates.filter(c => c.fields.email === 'info@leadintel.io' || c.fields.email === 'support@leadintel.io')
  assert.ok(emailCandidates.length >= 1, 'Company emails must be preserved')

  const phoneCandidate = candidates.find(c => c.fields.phone && c.fields.phone.includes('800'))
  assert.ok(phoneCandidate, 'Company phone must be preserved')
})
