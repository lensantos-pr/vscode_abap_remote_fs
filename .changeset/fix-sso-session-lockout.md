---
"vscode-abap-remote-fs": patch
---

Fix an SSO/Kerberos session bug that could walk a SAP account toward a lockout. A browser_sso or kerberos connection no longer sends a sentinel string as a basic-auth password — on either the client or the language-server path — so authentication is the Cookie/ticket alone and a lapsed session costs no failed logon. On an expired session (HTTP 401) the SSO client is torn down and reconnected rather than retried, while basic/cert/oauth connections still self-heal on the next request. Disconnect now fully clears cached clients, and an explicit reconnect clears the prior failure state.
