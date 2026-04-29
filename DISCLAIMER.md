# Disclaimer

**Last updated: 2026-04-28**

This document is a plain-language expansion of the MIT License that ships with arnie. In case of conflict, the MIT [LICENSE](LICENSE) controls.

By downloading, installing, running, linking against, or otherwise using arnie (the "Software"), you acknowledge and agree to everything below. If you do not agree, do not use the Software.

---

## 1. Provided "AS IS"

The Software is provided **"AS IS" and "AS AVAILABLE"**, without warranty of any kind, express, implied, or statutory, including but not limited to:

- warranties of merchantability, fitness for a particular purpose, title, or non-infringement
- warranties that the Software will be error-free, uninterrupted, secure, or free of harmful components
- warranties that any defect or bug will be corrected
- warranties regarding the accuracy, reliability, completeness, timeliness, or usefulness of any output produced by or through the Software, including but not limited to commands the model proposes or executes

No advice or information obtained from the authors, maintainers, contributors, or any channel associated with the project creates any warranty not expressly stated in the MIT License.

---

## 2. Limitation of liability

To the maximum extent permitted by applicable law, in no event shall the authors, maintainers, contributors, copyright holders, or any person associated with the project be liable for any:

- direct, indirect, incidental, special, exemplary, consequential, punitive, or any other damages
- loss of profits, revenue, data, goodwill, use, opportunity, or business
- service interruption, computer failure or malfunction, data loss, file corruption, or system damage
- costs of procurement of substitute goods or services
- claims by third parties

arising out of or in connection with the Software, its use, its inability to be used, its interaction with any third-party service or your local system, or any content produced by or through it, whether based on warranty, contract, tort (including negligence), strict liability, statute, or any other legal theory, and whether or not the project has been advised of the possibility of such damages.

Where liability cannot be fully excluded under applicable law, it is limited to the maximum extent permitted.

---

## 3. The agent is not the operator

arnie is an LLM-driven agent that proposes and executes shell commands, file edits, and other system mutations on your machine. Confirmation prompts (`[y/N]`), `--dry-run`, plan mode, sandbox config, and permissions config are guardrails — not guarantees.

**You** are the operator. You are responsible for reviewing each prompt before answering `y`, for understanding what a proposed command does before it runs, and for the consequences of running it. The model can be wrong. The redactor can miss a secret pattern it wasn't trained for. A skill or memory file you wrote can mislead the model. Treat every confirmation as a gate, not a formality.

---

## 4. No affiliation

arnie is an **independent, unofficial, third-party project**. It is:

- **not affiliated with, endorsed by, sponsored by, or in any way officially connected to** Anthropic PBC, Microsoft Corporation, the Linux Foundation, or any other company, product, or service mentioned in the documentation, source code, or test fixtures
- **not an official client, SDK, integration, or partner** of any of the above
- **not authorized to speak on behalf of** any of the above

All product names, logos, brands, trademarks, and registered trademarks referenced anywhere in this project are property of their respective owners. Use of those names is for identification and interoperability purposes only and does not imply endorsement.

---

## 5. User responsibility

You are solely responsible for:

- **Your use of the Anthropic API** (or any Anthropic-compatible endpoint, including [dario](https://github.com/askalf/dario) routing your requests to a Claude subscription). Your use of each upstream service is governed by that service's own terms of service, acceptable-use policy, privacy policy, rate limits, billing terms, and any other agreement you have with that service. Review them. Follow them.
- **Your API keys, OAuth credentials, and accounts.** You are responsible for all activity conducted under them. You are responsible for keeping them secure.
- **Compliance with all laws applicable to you and your use**, including but not limited to export control, sanctions, privacy, data protection, consumer protection, accessibility, and industry-specific regulations (HIPAA, PCI-DSS, FedRAMP, GDPR, CCPA, etc.).
- **The content you send through the Software and the content you receive back.** The project does not moderate, filter, store, or review this content. You are responsible for ensuring your inputs and outputs are lawful, ethical, and appropriate for your context.
- **The commands, file edits, and other actions arnie executes on your machine** when you confirm them. The project does not validate the safety or correctness of model proposals; you do.
- **Determining whether the Software is appropriate for your use case.** The Software is a general-purpose troubleshooting tool. It is not intended for, and is not warranted as suitable for, safety-critical, life-critical, mission-critical, high-availability, regulated, or production-grade environments without your own independent review, hardening, and diligence.

---

## 6. No support obligation

The project is operated on a **best-effort, volunteer basis**. There is no obligation, express or implied, to:

- respond to issues, discussions, pull requests, emails, or other communications
- fix bugs, address vulnerabilities, or publish updates on any timeline
- maintain backward compatibility between versions, except where explicitly stated in [STABILITY.md](STABILITY.md) and the release notes
- continue the project at all

Published service-level targets (e.g., 48-hour security acknowledgment in [SECURITY.md](SECURITY.md)) are goals, not contractual commitments.

---

## 7. No availability or continuity guarantee

The Software may stop working at any time, for any reason, including but not limited to:

- changes to the Anthropic API, model availability, pricing, or terms
- changes to operating systems, runtimes, dependencies, or shells
- the project entering maintenance mode, archive status, or being discontinued
- the project or its distribution channels (npm, GitHub) being unavailable, removed, or restricted

You should have a fallback plan if continuous availability matters to your workflow. Pinning a specific version does not guarantee that version will continue to function with third-party services as those services evolve.

---

## 8. Local data

arnie reads and writes data on your local filesystem under your home directory and current working directory: transcripts (`~/.arnie/transcripts/`), saved sessions (`~/.arnie/sessions/`), memory files, persona overrides, hooks config, sandbox config, permissions config, settings, feedback, and an in-process API key in `ANTHROPIC_API_KEY`.

- Storage is on the local filesystem under your home directory. The project relies on operating-system file permissions; it does not encrypt these files at rest.
- You are responsible for the security of your machine, your user account, your backups, and any system where these files are stored.
- The project is not responsible for credential compromise, transcript leakage, or data loss resulting from the security of your environment, your configuration choices, or third-party software running on your system.
- If you believe an `ANTHROPIC_API_KEY` may have been exposed (e.g., committed to a public repo), rotate it immediately at the Anthropic console.

---

## 9. Security reports

Security issues should be reported per [SECURITY.md](SECURITY.md). Nothing in this disclaimer modifies the security-reporting process; nothing in the security-reporting process creates an enforceable service-level agreement, warranty, or indemnity.

---

## 10. Export, sanctions, regulated use

The Software is distributed from the United States. You are responsible for complying with all applicable export-control laws, sanctions regimes, and regulations in your jurisdiction, and for ensuring the Software is not used in prohibited countries, by prohibited parties, or for prohibited end uses.

The Software is **not designed, tested, or warranted for use** in environments requiring specific regulatory certifications (HIPAA, PCI-DSS, FedRAMP, SOC 2, ISO 27001, FDA, FAA, NERC-CIP, etc.). If your use falls under such a regime, you are solely responsible for determining suitability and performing any required controls, audits, or risk assessments.

---

## 11. Indemnification

To the maximum extent permitted by applicable law, you agree to indemnify, defend, and hold harmless the authors, maintainers, contributors, and copyright holders of the Software from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or in connection with:

- your use of the Software
- the commands and file edits the Software executes on your behalf when you confirm them
- your violation of any third-party terms, policies, or agreements
- your violation of any law or regulation
- your violation of any third-party right, including privacy or intellectual property rights
- any content you transmit through or cause to be produced by the Software

---

## 12. Changes to this disclaimer

This document may be updated from time to time. Changes take effect on the date shown at the top of the file. Continued use of the Software after a change indicates acceptance of the updated disclaimer.

---

## 13. Governing law and severability

This disclaimer is to be interpreted consistently with the MIT License. If any provision is held to be unenforceable under applicable law, the remaining provisions remain in full force and effect, and the unenforceable provision shall be modified to the minimum extent necessary to make it enforceable while preserving its intent.

---

## 14. Questions

For questions about this disclaimer, open a GitHub discussion. For security issues, follow [SECURITY.md](SECURITY.md). The project does not provide legal advice; if you need legal advice, consult a qualified attorney in your jurisdiction.
