export interface HostedWorkspaceDevice {
  id: string
  label: string
  fingerprint: string
  createdAt: string
}

export interface HostedWorkspaceDevicesResponse {
  devices: HostedWorkspaceDevice[]
}

export interface RegisterHostedWorkspaceDeviceRequest {
  publicKey: string
  label: string
}

export interface RegisterHostedWorkspaceDeviceResponse {
  deviceId: string
  authorized: true
}

export type HostedWorkspaceClientTarget = "windows-x64" | "linux-x64"

export interface HostedWorkspaceClientDownload {
  target: HostedWorkspaceClientTarget
  label: string
  filename: string
  url: string
}

export interface HostedWorkspaceClientResponse {
  serverOrigin: string
  downloads: HostedWorkspaceClientDownload[]
}
