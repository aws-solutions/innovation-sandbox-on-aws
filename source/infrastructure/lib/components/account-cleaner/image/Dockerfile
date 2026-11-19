# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# To update: docker manifest inspect public.ecr.aws/amazonlinux/amazonlinux:2023-minimal | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
ARG BASE_IMAGE_DIGEST=sha256:afd87b5236fd9ac2df727ce1c65cd22e0bd72ff105656166c5024e1768e8ab75

# Build aws-nuke from source
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@${BASE_IMAGE_DIGEST} AS builder

ARG AWS_NUKE_VERSION=v3.69.1
# To update: curl -sL https://github.com/ekristen/aws-nuke/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256 | awk '{print $1}'
ARG AWS_NUKE_SOURCE_SHA256=6b616a95c6e0fd9335e59b618c89501e900a42c1210f9f0b080b90ce1cbbfc1d

RUN dnf install -y tar gzip golang patch

# Backup: install a pinned Go toolchain when Amazon Linux does not provide the
# version required by aws-nuke.
# ARG GO_VERSION=1.26.9
# ARG GO_SHA256=42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d
# RUN dnf install -y tar gzip git patch && \
#     curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz && \
#     echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - && \
#     tar -C /usr/local -xzf /tmp/go.tar.gz && \
#     rm /tmp/go.tar.gz
# ENV PATH="/usr/local/go/bin:${PATH}"

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
    GOTOOLCHAIN=local CGO_ENABLED=0 go build -o /usr/local/bin/aws-nuke .

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
