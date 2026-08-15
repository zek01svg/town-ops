project_id      = "seraphic-cocoa-505015-s9"
region          = "asia-southeast1"
zone            = "asia-southeast1-b"
vm_machine_type = "e2-small"
sql_tier        = "db-f1-micro"
r2_account_id   = "902f8ae18614451219d28d78036dd9bb"

# Both set by pass 2 of the Cloud Run apply -- see the comment in variables.tf.
# The pipeline overrides both with `-var` from `terraform output`, so these are
# the from-scratch-rebuild seed rather than the live source of truth.
gateway_url   = "https://gateway-3awkz54whq-as.a.run.app"
frontend_urls = ["https://frontend-contractor-3awkz54whq-as.a.run.app", "https://frontend-officer-3awkz54whq-as.a.run.app", "https://frontend-resident-3awkz54whq-as.a.run.app"]

# image_tag is deliberately NOT here. It used to be rewritten in place by
# build-push.sh on every build -- a pipeline mutating a tracked file. It now
# arrives as `-var image_tag=<git sha>` from .github/workflows/deploy.yml, and
# an operator applying by hand passes the same flag. The variable's "unset"
# default still lets a plan run before any image exists.
