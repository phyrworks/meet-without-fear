locals {
  buckets = {
    state   = "${var.name}-tfstate-${var.account_id}-${var.region}"
    backups = "${var.name}-backups-${var.account_id}-${var.region}"
  }
}
resource "aws_s3_bucket" "storage" {
  for_each = local.buckets
  bucket   = each.value
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "storage" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.storage[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "storage" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.storage[each.key].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_versioning" "storage" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.storage[each.key].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_policy" "tls" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.storage[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.storage[each.key].arn, "${aws_s3_bucket.storage[each.key].arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket     = aws_s3_bucket.storage["backups"].id
  depends_on = [aws_s3_bucket_versioning.storage]
  dynamic "rule" {
    for_each = { "nightly/" = 7, "preserved/" = 30, "releases/artifacts/" = 30 }
    content {
      id     = replace(rule.key, "/", "-")
      status = "Enabled"
      filter { prefix = rule.key }
      expiration { days = rule.value }
      noncurrent_version_expiration { noncurrent_days = rule.value }
      abort_incomplete_multipart_upload { days_after_initiation = 1 }
    }
  }
  rule {
    id     = "control-history"
    status = "Enabled"
    filter { prefix = "releases/control/" }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
}
resource "aws_lightsail_key_pair" "operator" {
  name       = "${var.name}-operator"
  public_key = var.ssh_public_key
}
resource "aws_lightsail_instance" "api" {
  name              = var.name
  availability_zone = "${var.region}a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "small_3_0"
  key_pair_name     = aws_lightsail_key_pair.operator.name
  ip_address_type   = "ipv4"
  user_data         = "bash <<'MWF_BOOTSTRAP'\n${file("${path.module}/bootstrap.sh")}\nMWF_BOOTSTRAP\n"
  lifecycle {
    prevent_destroy = true
    # User data is first-boot only. Apply bootstrap fixes explicitly to existing hosts.
    ignore_changes = [user_data]
  }
}
resource "aws_lightsail_static_ip" "api" {
  name = "${var.name}-ip"
  lifecycle { prevent_destroy = true }
}
resource "aws_lightsail_static_ip_attachment" "api" {
  static_ip_name = aws_lightsail_static_ip.api.name
  instance_name  = aws_lightsail_instance.api.name
}
resource "aws_lightsail_instance_public_ports" "api" {
  instance_name = aws_lightsail_instance.api.name
  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.operator_cidrs
  }
  dynamic "port_info" {
    for_each = [80, 443]
    content {
      protocol  = "tcp"
      from_port = port_info.value
      to_port   = port_info.value
      cidrs     = ["0.0.0.0/0"]
    }
  }
}
# Keys are created outside Terraform and delivered directly into protected host files.
resource "aws_iam_user" "backup" { name = "${var.name}-backup-writer" }
resource "aws_iam_user_policy" "backup" {
  user = aws_iam_user.backup.name
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["s3:PutObject"],
    Resource = [for prefix in ["nightly", "preserved"] : "${aws_s3_bucket.storage["backups"].arn}/${prefix}/*"]
  }] })
}
resource "aws_iam_user" "release_reader" { name = "${var.name}-release-reader" }
resource "aws_iam_user_policy" "release_reader" {
  user = aws_iam_user.release_reader.name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.storage["backups"].arn}/releases/*" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.storage["backups"].arn}/releases/status/*" }
  ] })
}
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "deploy" {
  name = "${var.name}-github-deploy"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Federated = aws_iam_openid_connect_provider.github.arn },
    Action = "sts:AssumeRoleWithWebIdentity",
    Condition = { StringEquals = {
      "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub" = [for ref in var.deployment_refs : "repo:${var.github_repository}:ref:${ref}"]
    } }
  }] })
}
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = [for p in ["artifacts", "control"] : "${aws_s3_bucket.storage["backups"].arn}/releases/${p}/*"] },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.storage["backups"].arn}/releases/status/*" }
  ] })
}
output "static_ip" { value = aws_lightsail_static_ip.api.ip_address }
output "instance_name" { value = aws_lightsail_instance.api.name }
output "state_bucket" { value = aws_s3_bucket.storage["state"].id }
output "backup_bucket" { value = aws_s3_bucket.storage["backups"].id }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
