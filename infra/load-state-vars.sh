# Restore the TF_VAR_* values that Terraform's own state already holds.
# Source it, do not execute it:  source infra/load-state-vars.sh
#
# WHY THIS EXISTS. On 2026-10-20 a recovery apply was nearly run from a shell
# that had lost its exports. Nothing would have failed loudly: the five provider
# credentials prompt when missing, but auth_secret, the two Google OAuth values
# and site_url all default to "" — and vercel.tf builds its for_each key set
# with compact(), so an empty value does not write a blank variable, it DESTROYS
# the environment variable. Sign-in would have broken exactly as it did before,
# from an apply that looked routine.
#
# Everything below is a resource attribute, so it already sits in
# terraform.tfstate in plaintext. auth_secret in particular exists nowhere else:
# no console can reissue it, and a fresh one invalidates every live session.
#
# Provider credentials (neon_api_key, upstash_email, upstash_api_key,
# vercel_api_token, grafana_cloud_access_policy_token) are deliberately absent.
# They configure providers rather than resources, so Terraform never stores
# them. Export those five by hand.
#
# NO `set -e`, `set -u` OR `set -o pipefail` HERE, EVER. A sourced script shares
# the interactive shell's options: the first version of this file set all three
# and closed the user's terminal on the first non-zero return. For the same
# reason there is no `exit`, which would also kill the shell.
#
# Portable between zsh and bash on purpose — the repo's shell is zsh, but
# BASH_SOURCE and ${(%):-%x} are each a parse error in the other, so the state
# file is located by searching instead of by introspection.

_mise_state=""
for _d in "$PWD/infra" "$PWD" "$(git rev-parse --show-toplevel 2>/dev/null)/infra"; do
  if [ -r "$_d/terraform.tfstate" ]; then _mise_state="$_d/terraform.tfstate"; break; fi
done

if [ -z "$_mise_state" ]; then
  echo "load-state-vars: no readable terraform.tfstate near $PWD" >&2
else
  _mise_vercel() {
    jq -r --arg k "$1" '
      .resources[] | select(.type=="vercel_project_environment_variable")
      | .instances[] | select(.index_key==$k) | .attributes.value // empty
    ' "$_mise_state" 2>/dev/null
  }
  _mise_run() {
    jq -r --arg k "$1" '
      .resources[] | select(.type=="google_cloud_run_v2_service")
      | .instances[].attributes.template[0].containers[0].env[]?
      | select(.name==$k) | .value // empty
    ' "$_mise_state" 2>/dev/null
  }

  export TF_VAR_auth_secret="$(_mise_vercel AUTH_SECRET)"
  export TF_VAR_google_oauth_client_id="$(_mise_vercel AUTH_GOOGLE_ID)"
  export TF_VAR_google_oauth_client_secret="$(_mise_vercel AUTH_GOOGLE_SECRET)"
  export TF_VAR_site_url="$(_mise_vercel NEXT_PUBLIC_SITE_URL)"
  export TF_VAR_youtube_api_key="$(_mise_run YOUTUBE_API_KEY)"
  export TF_VAR_gemini_api_key="$(_mise_run GEMINI_API_KEY)"
  export TF_VAR_neon_org_id="$(jq -r '.resources[]|select(.type=="neon_project")|.instances[].attributes.org_id // empty' "$_mise_state" 2>/dev/null)"

  # The SNS subscription endpoint, once one exists. Added after the recovery
  # apply created the alarm and the topic but not the subscription: the shell
  # holding TF_VAR_alert_email had been lost, and `count = var.alert_email == ""
  # ? 0 : 1` resolved to zero without complaint. The alarm was wired to a topic
  # nobody was listening to, which looks configured in every view except the
  # subscription list.
  #
  # Exported only when found. Exporting an empty one would be the very trap
  # this file exists to close — an empty value here destroys the subscription
  # on the next apply, exactly as it does for the Vercel variables above.
  _mise_alert="$(jq -r '.resources[]|select(.type=="aws_sns_topic_subscription")|.instances[].attributes.endpoint // empty' "$_mise_state" 2>/dev/null)"
  if [ -n "$_mise_alert" ]; then export TF_VAR_alert_email="$_mise_alert"; fi
  export TF_VAR_gcp_project_id="$(jq -r '.resources[]|select(.type=="google_cloud_run_v2_service")|.instances[].attributes.project // empty' "$_mise_state" 2>/dev/null)"

  # Shape only. A length is not a secret, and it catches an empty extraction —
  # which is the exact failure this script exists to prevent. Spelled out one
  # variable at a time because indirect expansion is ${!n} in bash and ${(P)n}
  # in zsh, and this file has to parse in both.
  printf '  %-36s %d chars\n' TF_VAR_auth_secret                 "${#TF_VAR_auth_secret}"
  printf '  %-36s %d chars\n' TF_VAR_google_oauth_client_id      "${#TF_VAR_google_oauth_client_id}"
  printf '  %-36s %d chars\n' TF_VAR_google_oauth_client_secret  "${#TF_VAR_google_oauth_client_secret}"
  printf '  %-36s %d chars\n' TF_VAR_site_url                    "${#TF_VAR_site_url}"
  printf '  %-36s %d chars\n' TF_VAR_youtube_api_key             "${#TF_VAR_youtube_api_key}"
  printf '  %-36s %d chars\n' TF_VAR_gemini_api_key              "${#TF_VAR_gemini_api_key}"
  printf '  %-36s %d chars\n' TF_VAR_neon_org_id                 "${#TF_VAR_neon_org_id}"
  printf '  %-36s %d chars\n' TF_VAR_gcp_project_id              "${#TF_VAR_gcp_project_id}"
  if [ -n "$_mise_alert" ]; then
    printf '  %-36s %d chars\n' TF_VAR_alert_email               "${#_mise_alert}"
  else
    echo "  TF_VAR_alert_email                   no subscription in state — export it to create one"
  fi
  echo "  (0 chars anywhere above means the apply would DESTROY that variable)"

  unset -f _mise_vercel _mise_run
fi
unset _d _mise_state _mise_alert
