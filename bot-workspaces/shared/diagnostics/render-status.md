# AWS API Deployment Status

This filename is retained for existing workspace links. Production is AWS Lightsail at `https://api.meetwithoutfear.com`; there is no separate staging service provisioned by this migration.

## Checks

```bash
curl --fail --silent --show-error --max-time 15 https://api.meetwithoutfear.com/health
gh run list --repo shantamg/meet-without-fear --workflow aws-deploy.yml --limit 5
```

Inspect the relevant run with `gh run view RUN_ID`. A successful AWS Deploy run confirms that the host reported the requested release healthy. Compare the run's commit with the change being verified; an unrelated successful release does not establish deployment of that change.

On the operator machine, inspect the current release and operational health:

```bash
ssh mwf-api 'sudo cat /var/lib/mwf/current-release.json; sudo /opt/mwf/ops-health.sh'
```

The bot's restricted database tunnel cannot run host commands. If host access is unavailable, report that limitation and use public health, GitHub deployment results, Sentry, and read-only database checks. Do not retrieve or print runtime environment files. See `infra/aws/README.md`.
