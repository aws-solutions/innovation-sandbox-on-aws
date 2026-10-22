# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# To update: docker manifest inspect public.ecr.aws/amazonlinux/amazonlinux:2023-minimal | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
ARG BASE_IMAGE_DIGEST=sha256:478c519817ce1c2cdc64700e4395775143446f8706706906b942960f0394ff2e

# Build aws-nuke from source
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@${BASE_IMAGE_DIGEST} AS builder

ARG AWS_NUKE_VERSION=v3.68.3
# To update: curl -sL https://github.com/ekristen/aws-nuke/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256 | awk '{print $1}'
ARG AWS_NUKE_SOURCE_SHA256=2f06b307aa1addccf9231f0fd1f394c63507a8c7438e8113a91386066be0d6aa

# Go 1.26.1+ required by aws-nuke v3.68.3 (AL2023 only ships Go 1.25.x via dnf)
# Patched to 1.26.9 to pick up Go stdlib security fixes (see CHANGELOG v1.3.6)
ARG GO_VERSION=1.26.9
ARG GO_SHA256=42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d

RUN dnf install -y tar gzip git patch && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz && \
    echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm /tmp/go.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"

ADD https://github.com/ekristen/aws-nuke/archive/refs/tags/${AWS_NUKE_VERSION}.tar.gz /tmp/aws-nuke-src.tar.gz
RUN echo "${AWS_NUKE_SOURCE_SHA256}  /tmp/aws-nuke-src.tar.gz" | sha256sum -c - && \
    mkdir -p /tmp/aws-nuke-src && \
    tar -xzf /tmp/aws-nuke-src.tar.gz -C /tmp/aws-nuke-src --strip-components=1

COPY patches/ /tmp/patches/
RUN cd /tmp/aws-nuke-src && \
    found=false && \
    for p in /tmp/patches/*.patch; do \
      [ -f "$p" ] || continue; \
      echo "Applying patch: $(basename "$p")" && \
      patch -p1 < "$p" || exit 1; \
      found=true; \
    done && \
    if [ "$found" = true ]; then echo "All patches applied successfully"; \
    else echo "No patches to apply"; fi

RUN cd /tmp/aws-nuke-src && \
    GOTOOLCHAIN=local GOPROXY=direct GONOSUMCHECK='*' GONOSUMDB='*' CGO_ENABLED=0 go build -o /usr/local/bin/aws-nuke .

# Runtime image
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@${BASE_IMAGE_DIGEST}

RUN dnf install -y awscli jq sed yq

COPY --from=builder /usr/local/bin/aws-nuke /usr/local/bin/aws-nuke
RUN chmod +x /usr/local/bin/aws-nuke

# ISB-required nuke entries and the script that merges them into the customer's
# config. These ship with the image rather than with the CDK app because the overlay
# contents are aws-nuke resource-type identifiers and must stay in lockstep with the
# aws-nuke binary above.
COPY nuke-config.isb-overlay.yaml /opt/isb/nuke-config.isb-overlay.yaml
COPY isb-prepare-nuke-config.sh /usr/local/bin/isb-prepare-nuke-config
RUN chmod +x /usr/local/bin/isb-prepare-nuke-config

ENV PATH=$PATH:/usr/local/bin

USER codebuild-user
