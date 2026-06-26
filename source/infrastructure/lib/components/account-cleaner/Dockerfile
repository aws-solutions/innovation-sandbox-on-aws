# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# To update: docker manifest inspect public.ecr.aws/amazonlinux/amazonlinux:2023-minimal | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
ARG BASE_IMAGE_DIGEST=sha256:ad1631264f6c66c2111d583bcab1eca920bc9ff3e8c8304227f04338697c3193

# Build aws-nuke from source
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@${BASE_IMAGE_DIGEST} AS builder

ARG AWS_NUKE_VERSION=v3.64.1
# To update: curl -sL https://github.com/ekristen/aws-nuke/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256 | awk '{print $1}'
ARG AWS_NUKE_SOURCE_SHA256=23c28fd84afdf16eb69725055dce59cb1581d0ba38e07c5ba6bbd431e0b98ba9

RUN dnf install -y tar gzip golang patch

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

RUN dnf install -y awscli jq sed

COPY --from=builder /usr/local/bin/aws-nuke /usr/local/bin/aws-nuke
RUN chmod +x /usr/local/bin/aws-nuke

ENV PATH=$PATH:/usr/local/bin

USER codebuild-user
