# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# To update: docker manifest inspect public.ecr.aws/amazonlinux/amazonlinux:2023-minimal | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
ARG BASE_IMAGE_DIGEST=sha256:eacb3cccd1675ac3cbef0033dd437dc69c6cd4d96dc5d0ebbdbb12830e10aee1

# Build aws-nuke from source
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@${BASE_IMAGE_DIGEST} AS builder

ARG AWS_NUKE_VERSION=v3.65.0
# To update: curl -sL https://github.com/ekristen/aws-nuke/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256 | awk '{print $1}'
ARG AWS_NUKE_SOURCE_SHA256=feb73b963ef14fe8fb1a3b77ad274e497edf41479a8f5d02155d0144de5625e1

# Go 1.26.5 required by aws-nuke v3.65.0 (AL2023 only ships Go 1.25.x via dnf)
ARG GO_VERSION=1.26.5
ARG GO_SHA256=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053

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

RUN dnf install -y awscli jq sed

COPY --from=builder /usr/local/bin/aws-nuke /usr/local/bin/aws-nuke
RUN chmod +x /usr/local/bin/aws-nuke

ENV PATH=$PATH:/usr/local/bin

USER codebuild-user
