package pci

default allow = false

allow {
  no_critical_encryption_failures
  no_critical_logging_failures
}

no_critical_encryption_failures {
  failed_encryption := [r | r := input.results.failed_checks[_]; contains(r.check_id, "CKV_AWS_28")]
  count(failed_encryption) == 0
}

no_critical_logging_failures {
  failed_logging := [r | r := input.results.failed_checks[_]; contains(r.check_id, "CKV_AWS_76")]
  count(failed_logging) == 0
}
