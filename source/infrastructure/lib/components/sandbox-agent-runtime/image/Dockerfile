# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# AgentCore Runtime is Graviton-only, so the image is arm64, but it must build on
# x86 hosts without QEMU: every RUN executes on $BUILDPLATFORM, arm64 stages only COPY.
# Requires BuildKit (the legacy builder does not define $BUILDPLATFORM).
#
# How it works:
#   1. Pin the multi-architecture Amazon Linux image, not an arm64-only one.
#   2. Use its build-host ($BUILDPLATFORM) variant for the build stages.
#   3. Build the application and install its dependencies natively on the build host.
#   4. Prepare an arm64 root filesystem (runtime-rootfs) without executing arm64 code.
#   5. Use the image's arm64 variant for the final stage.
#   6. Copy the prepared root filesystem and the application into it.
#   7. Only the final arm64 stage is published; the build stages are discarded.
#
# Base image: public.ecr.aws/amazonlinux/amazonlinux:2023-minimal, pinned by its
# multi-arch index digest in the four FROM lines below. Keep them identical (a unit
# test checks this); each stage picks its platform from it.
# To update: docker buildx imagetools inspect public.ecr.aws/amazonlinux/amazonlinux:2023-minimal | awk '/^Digest:/{print $2}'

FROM --platform=linux/arm64 public.ecr.aws/amazonlinux/amazonlinux@sha256:8873a7cbc7c3d51d55a749c7c4c7894b7981f0514c269003c7952cf3ed550d27 AS runtime-base

# Node and the workspace package.json files, shared by the build and the production
# install below, so a source edit invalidates neither npm ci.
FROM --platform=$BUILDPLATFORM public.ecr.aws/amazonlinux/amazonlinux@sha256:8873a7cbc7c3d51d55a749c7c4c7894b7981f0514c269003c7952cf3ed550d27 AS npm-base

RUN dnf install -y nodejs24 nodejs24-npm && dnf clean all

WORKDIR /build

# Manifests before source so the dependency install stays cached across code edits.
COPY package.json package-lock.json ./
COPY source/common/package.json ./source/common/
COPY source/shared/package.json ./source/shared/
COPY source/agent-runtime/package.json ./source/agent-runtime/
COPY source/layers/dependencies/package.json ./source/layers/dependencies/

FROM npm-base AS builder

# The dependencies layer is included because source/common's barrel files import
# AWS SDK clients that are declared there rather than in source/common itself.
RUN npm ci --workspace @amzn/innovation-sandbox-commons \
           --workspace @amzn/innovation-sandbox-shared \
           --workspace @amzn/innovation-sandbox-agent-runtime \
           --workspace @amzn/innovation-sandbox-layer-dependencies \
           --include-workspace-root

COPY source/common/ ./source/common/
COPY source/shared/ ./source/shared/
COPY source/agent-runtime/ ./source/agent-runtime/

# Bundling exists only to rewrite the `@amzn/...` tsconfig path aliases, which are
# compile-time-only and unresolvable by Node. npm packages stay external so
# OpenTelemetry can instrument them as they load.
RUN npm run bundle --workspace @amzn/innovation-sandbox-agent-runtime

# Separate step: esbuild strips types without checking them.
RUN npm run build --workspace @amzn/innovation-sandbox-agent-runtime

# The bundle is ESM because the AgentCore SDK reads `import.meta.url`.
RUN printf '{"type":"module"}\n' > /build/runtime-package.json

# The runtime's production dependencies, as package-lock.json pins them:
# source/agent-runtime/package.json depends on the Lambda dependencies layer
# (the SDK clients and utilities the bundled source/common code imports) plus the
# agent's own packages, so one npm ci builds the whole tree. Workspace links are
# removed: their code is in the bundle.
FROM npm-base AS runtime-dependencies

# npm runs on the build host here. --cpu/--os make it fetch the arm64 Linux build of
# any platform-specific optional dependency. An addon compiled during install would
# still target the host, so the build fails if one appears.
RUN npm ci --workspace @amzn/innovation-sandbox-agent-runtime --omit=dev --no-audit --no-fund \
        --cpu=arm64 --os=linux \
    && if find node_modules source/agent-runtime/node_modules -name '*.node' 2>/dev/null | grep -q .; then \
        echo "A native addon was built for the build host, not arm64" >&2; exit 1; \
    fi \
    && rm -rf node_modules/@amzn \
    && mkdir -p source/agent-runtime/node_modules

# arm64 OS packages, unpacked (not executed) on the build host into a copy of the
# arm64 base. microdnf lacks --forcearch, so swap in dnf. RPM scriptlets are skipped,
# so the `node` alternatives link is made by hand.
FROM --platform=$BUILDPLATFORM public.ecr.aws/amazonlinux/amazonlinux@sha256:8873a7cbc7c3d51d55a749c7c4c7894b7981f0514c269003c7952cf3ed550d27 AS runtime-rootfs

RUN microdnf swap -y microdnf-dnf dnf && microdnf clean all

COPY --from=runtime-base / /rootfs/

RUN releasever="$(rpm --root /rootfs -q --qf '%{VERSION}' system-release)" \
    && dnf install -y --installroot=/rootfs --forcearch=aarch64 --releasever="${releasever}" \
        --setopt=varsdir=/etc/dnf/vars --setopt=tsflags=noscripts --nodocs \
        nodejs24 awscli jq less groff-base \
    && dnf clean all --installroot=/rootfs \
    && ln -sf node-24 /rootfs/usr/bin/node

# From the arm64 base (not scratch) so the image is labeled arm64 on x86 builders.
FROM --platform=linux/arm64 public.ecr.aws/amazonlinux/amazonlinux@sha256:8873a7cbc7c3d51d55a749c7c4c7894b7981f0514c269003c7952cf3ed550d27

COPY --from=runtime-rootfs /rootfs/ /

WORKDIR /app

# npm's layout from /build, unchanged, so the bundle resolves packages as it
# does in the repository (including the few npm installs under the workspace).
COPY --from=runtime-dependencies /build/node_modules ./node_modules
COPY --from=runtime-dependencies /build/source/agent-runtime/node_modules ./source/agent-runtime/node_modules
COPY --from=builder /build/source/agent-runtime/dist/main.mjs ./source/agent-runtime/dist/main.mjs
COPY --from=builder /build/runtime-package.json ./package.json

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER nobody

ENTRYPOINT ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "source/agent-runtime/dist/main.mjs"]
