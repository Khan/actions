# Sorted, so a change in API order does not open an update PR.
{
  domains: {
    actions_inbound: {
      full_domains: (.domains.actions_inbound.full_domains | sort),
      wildcard_domains: (.domains.actions_inbound.wildcard_domains | sort)
    }
  }
}
