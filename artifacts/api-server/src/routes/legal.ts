import { Router, type IRouter, type Request, type Response } from "express";
import { nonceAttr } from "../lib/csp-nonce.js";

const router: IRouter = Router();

const LAST_UPDATED = "June 24, 2026";
const CONTACT_EMAIL = "support@asktoact.ai";

const brandLogo = `<svg width="30" height="30" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4338CA"/><stop offset="55%" stop-color="#4F46E5"/><stop offset="100%" stop-color="#0EA5E9"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#g)"/><path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fill-opacity="0.97"/><line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" stroke-width="3" stroke-linecap="round"/><polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Shared document chrome for legal pages. `bodyHtml` is trusted, statically
 * authored content (no user input), so it is intentionally not escaped.
 */
function legalPage(opts: {
  title: string;
  intro: string;
  bodyHtml: string;
  activeTab: "privacy" | "terms";
}): string {
  const { title, intro, bodyHtml, activeTab } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | AskToAct</title>
<meta name="description" content="${title} for AskToAct — the connector bridging your AI assistant to Bullhorn ATS.">
<style${nonceAttr()}>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#cbd5e1;margin:0;line-height:1.7}
.wrap{max-width:760px;margin:0 auto;padding:48px 24px 96px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:40px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc}
.logo-text span{color:#38BDF8}
.tabs{display:flex;gap:8px}
.tab{padding:6px 14px;border-radius:20px;border:1px solid #1e2a3a;background:#0f1622;color:#64748b;font-size:13px;font-weight:600;text-decoration:none;transition:all .15s}
.tab:hover{border-color:#38bdf8;color:#94a3b8}
.tab.active{border-color:#4F46E5;background:rgba(79,70,229,.15);color:#818cf8}
h1{font-size:30px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc;margin:0 0 8px}
.updated{font-size:13px;color:#64748b;margin:0 0 24px}
.intro{font-size:15px;color:#94a3b8;margin:0 0 36px;padding:16px 18px;background:rgba(79,70,229,.07);border:1px solid rgba(79,70,229,.2);border-radius:10px}
h2{font-size:18px;font-weight:700;color:#e8ecf3;margin:38px 0 12px;letter-spacing:-0.01em}
h3{font-size:15px;font-weight:700;color:#cbd5e1;margin:24px 0 8px}
p{font-size:15px;margin:0 0 14px}
ul{margin:0 0 16px;padding-left:22px}
li{font-size:15px;margin-bottom:8px}
strong{color:#e8ecf3}
a{color:#818cf8;text-decoration:none}
a:hover{color:#38bdf8;text-decoration:underline}
table{width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:14px}
th,td{text-align:left;padding:10px 12px;border:1px solid #1e2a3a;vertical-align:top}
th{background:#0f1622;color:#94a3b8;font-weight:600}
.callout{font-size:14px;color:#94a3b8;padding:14px 16px;background:#0f1622;border:1px solid #1e2a3a;border-left:3px solid #4F46E5;border-radius:8px;margin:20px 0}
footer{border-top:1px solid #1e2a3a;margin-top:56px;padding-top:24px;font-size:13px;color:#475569;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
footer a{color:#64748b}
</style></head>
<body>
<div class="wrap">
  <div class="topbar">
    <a class="logo" href="/"><span style="display:flex">${brandLogo}</span><span class="logo-text">Ask<span>To</span>Act</span></a>
    <div class="tabs">
      <a class="tab ${activeTab === "privacy" ? "active" : ""}" href="/privacy">Privacy</a>
      <a class="tab ${activeTab === "terms" ? "active" : ""}" href="/terms">Terms</a>
    </div>
  </div>
  <h1>${title}</h1>
  <p class="updated">Last updated: ${LAST_UPDATED}</p>
  <p class="intro">${intro}</p>
  ${bodyHtml}
  <footer>
    <span>&copy; ${new Date().getFullYear()} AskToAct. All rights reserved.</span>
    <span>Questions? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></span>
  </footer>
</div>
</body></html>`;
}

const privacyBody = `
<p>AskToAct ("AskToAct", "we", "us", or "our") provides a connector service that lets recruiting professionals use their own AI assistant (such as ChatGPT, Claude, Gemini, or Grok) to search and update records in the Bullhorn applicant tracking system ("Bullhorn"). This Privacy Policy explains what information we collect, how we use it, who we share it with, and the choices you have.</p>

<h2>1. Who this policy covers</h2>
<p>This policy applies to two groups of people:</p>
<ul>
  <li><strong>Firm administrators</strong> who sign in to the AskToAct customer portal to manage their team and subscription.</li>
  <li><strong>Recruiters and users</strong> who connect their individual Bullhorn account to an AI assistant through AskToAct.</li>
</ul>

<h2>2. Information we collect</h2>
<table>
  <tr><th>Category</th><th>What it includes</th><th>Why we collect it</th></tr>
  <tr><td>Account information</td><td>Name and email address. Firm administrators authenticate through our identity provider; recruiters are provisioned by their firm administrator.</td><td>To create and manage accounts and send enrollment links.</td></tr>
  <tr><td>Bullhorn connection credentials</td><td>The Bullhorn username and password you enter during enrollment are used once to obtain OAuth access on your behalf. We retain only the resulting OAuth refresh token, not your password.</td><td>To maintain your authenticated connection to Bullhorn so your AI assistant can act under your own Bullhorn identity.</td></tr>
  <tr><td>Bullhorn record data</td><td>Candidates, job orders, placements, notes, résumés, and related records that your AI assistant requests.</td><td>Accessed in real time to fulfill each request. This content is passed back to your AI assistant and is not retained by AskToAct beyond the duration of the request.</td></tr>
  <tr><td>Usage data</td><td>Which connector tools were used, when, and by whom, plus basic request metadata.</td><td>To enforce subscription limits, provide usage analytics to firm administrators, and operate the service.</td></tr>
  <tr><td>Billing information</td><td>Subscription status and plan. Payment card details are handled directly by our payment processor; we do not store full card numbers.</td><td>To manage subscriptions and billing.</td></tr>
</table>

<h2>3. How we use information</h2>
<ul>
  <li>To execute the requests your AI assistant makes against Bullhorn, under your own Bullhorn identity and permissions.</li>
  <li>To authenticate users and maintain secure connections.</li>
  <li>To enforce subscription entitlements and provide firm administrators with usage analytics.</li>
  <li>To send transactional communications such as enrollment links and service notices.</li>
  <li>To monitor, troubleshoot, secure, and improve the service.</li>
</ul>

<h2>4. How your AI assistant fits in</h2>
<p>AskToAct does not provide the AI model. You connect AskToAct to a third-party AI assistant of your choice. When you use that assistant, the content of your prompts and the Bullhorn data returned to fulfill them flow through that provider, which has its own privacy policy and terms. We encourage you to review the policies of whichever AI provider you connect.</p>

<h2>5. Service providers we rely on</h2>
<p>We share information only as needed with the following categories of providers, each acting on our behalf or as an independent service you have chosen:</p>
<ul>
  <li><strong>Bullhorn</strong> — the applicant tracking system that is the source and destination of the recruiting data you access.</li>
  <li><strong>Payment processor</strong> — to manage subscriptions and process payments.</li>
  <li><strong>Identity provider</strong> — to authenticate firm administrators signing in to the portal.</li>
  <li><strong>Email delivery provider</strong> — to send enrollment links and transactional email.</li>
  <li><strong>Cloud hosting provider</strong> — to host and run the service.</li>
  <li><strong>AI assistant provider</strong> — the AI tool you choose to connect (for example ChatGPT, Claude, Gemini, or Grok).</li>
</ul>
<p>We do not sell your personal information, and we do not use your Bullhorn record data to train AI models.</p>

<h2>6. Data retention</h2>
<p>We retain account information, connection tokens, and usage records for as long as your account is active or as needed to provide the service. Bullhorn record content accessed to fulfill a request is processed transiently and is not stored after the request completes. When an account is closed, we delete or de-identify associated data within a reasonable period, except where we must retain it to comply with legal obligations or resolve disputes.</p>

<h2>7. Security</h2>
<p>We use industry-standard safeguards to protect information, including encrypted connections, scoped per-user authentication so that each user acts only with their own Bullhorn permissions, and restricted access to stored credentials. No method of transmission or storage is completely secure, but we work to protect your information and review our practices regularly.</p>

<h2>8. Your choices and rights</h2>
<ul>
  <li>You may disconnect your Bullhorn connection at any time, which revokes AskToAct's stored access.</li>
  <li>You may request access to, correction of, or deletion of your personal information by contacting us.</li>
  <li>Firm administrators can request that a user's access be removed.</li>
</ul>
<p>Depending on where you live, you may have additional rights under applicable privacy laws. We will honor valid requests as required by law.</p>

<h2>9. Changes to this policy</h2>
<p>We may update this Privacy Policy from time to time. When we make material changes, we will update the "Last updated" date above and, where appropriate, provide additional notice.</p>

<h2>10. Contact us</h2>
<p>If you have questions about this policy or your information, contact us at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

const termsBody = `
<p>These Terms of Service ("Terms") govern your access to and use of AskToAct (the "Service"). By using the Service, you agree to these Terms. If you are using the Service on behalf of an organization, you represent that you have authority to bind that organization to these Terms.</p>

<h2>1. The Service</h2>
<p>AskToAct is a connector that lets you use a third-party AI assistant to read from and write to the Bullhorn applicant tracking system under your own Bullhorn identity and permissions. AskToAct does not provide the AI assistant or the applicant tracking system; it bridges the two.</p>

<h2>2. Accounts and eligibility</h2>
<ul>
  <li>You must provide accurate information and keep your credentials secure.</li>
  <li>You are responsible for activity that occurs under your account and your connected Bullhorn identity.</li>
  <li>Firm administrators are responsible for managing the users they provision and for ensuring those users are authorized to access the firm's Bullhorn data.</li>
</ul>

<h2>3. Subscriptions and billing</h2>
<ul>
  <li>Access to the Service requires an active subscription. Plans, seat limits, and pricing are presented at the time of purchase.</li>
  <li>Subscriptions renew automatically until canceled. Fees are billed through our payment processor.</li>
  <li>Except where required by law, fees are non-refundable.</li>
</ul>

<h2>4. Your responsibilities and acceptable use</h2>
<ul>
  <li>You will use the Service only with Bullhorn data you are authorized to access, and only in compliance with your agreements with Bullhorn and your own organization's policies.</li>
  <li>You will operate within the permissions assigned to your Bullhorn identity. The Service does not grant access beyond what your Bullhorn account already allows.</li>
  <li>You will not misuse the Service, attempt to circumvent security or access controls, or use it for unlawful purposes.</li>
  <li>You are responsible for the prompts you send to your AI assistant and for reviewing the actions it takes, including any writes back to Bullhorn.</li>
</ul>

<h2>5. Third-party services</h2>
<p>The Service depends on third parties you choose or rely on, including Bullhorn and your AI assistant provider. Your use of those services is governed by their own terms and policies. We are not responsible for the availability, accuracy, or actions of third-party services.</p>

<h2>6. Data</h2>
<p>Our handling of personal information is described in our <a href="/privacy">Privacy Policy</a>. As between you and AskToAct, the Bullhorn record data you access remains the property of your organization and its data sources. You grant us the limited rights necessary to operate the Service on your behalf.</p>

<h2>7. Intellectual property</h2>
<p>AskToAct and its underlying software, branding, and documentation are owned by AskToAct and protected by applicable law. These Terms do not grant you any ownership of the Service. We grant you a limited, non-exclusive, non-transferable right to use the Service in accordance with these Terms.</p>

<h2>8. Disclaimers</h2>
<p>The Service is provided "as is" and "as available" without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or that AI-generated outputs or actions will be accurate or appropriate. You are responsible for verifying results before relying on them.</p>

<h2>9. Limitation of liability</h2>
<p>To the maximum extent permitted by law, AskToAct will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of data, revenue, or profits, arising out of or related to your use of the Service. Our total liability for any claim relating to the Service will not exceed the amount you paid us for the Service in the twelve months before the event giving rise to the claim.</p>

<h2>10. Termination</h2>
<p>You may stop using the Service and cancel your subscription at any time. We may suspend or terminate access if you violate these Terms, fail to pay applicable fees, or where required to protect the Service or comply with law. Upon termination, your right to use the Service ends.</p>

<h2>11. Changes to the Service and these Terms</h2>
<p>We may modify the Service or these Terms from time to time. When we make material changes to these Terms, we will update the "Last updated" date above and, where appropriate, provide additional notice. Your continued use of the Service after changes take effect constitutes acceptance of the revised Terms.</p>

<h2>12. Contact</h2>
<p>Questions about these Terms can be sent to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

router.get("/privacy", (_req: Request, res: Response) => {
  res
    .type("html")
    .send(
      legalPage({
        title: "Privacy Policy",
        intro:
          "Your privacy matters. This policy explains what AskToAct collects, how we use it, and the choices you have when connecting your AI assistant to Bullhorn.",
        bodyHtml: privacyBody,
        activeTab: "privacy",
      }),
    );
});

router.get("/terms", (_req: Request, res: Response) => {
  res
    .type("html")
    .send(
      legalPage({
        title: "Terms of Service",
        intro:
          "These terms govern your use of AskToAct. Please read them carefully — by using the Service you agree to them.",
        bodyHtml: termsBody,
        activeTab: "terms",
      }),
    );
});

export default router;
