variable "region" {
  type    = string
  default = "us-west-2"
}
variable "account_id" {
  type    = string
  default = "679575633563"
}
variable "name" {
  type    = string
  default = "mwf-api"
}
variable "operator_cidrs" {
  type = list(string)
  validation {
    condition     = length(var.operator_cidrs) > 0 && alltrue([for c in var.operator_cidrs : can(cidrhost(c, 0)) && !endswith(c, "/0")])
    error_message = "Supply restricted operator IPv4 CIDRs; never /0."
  }
}
variable "ssh_public_key" { type = string }
variable "github_repository" {
  type    = string
  default = "shantamg/meet-without-fear"
}
variable "deployment_refs" {
  type    = list(string)
  default = ["refs/heads/main"]
}
