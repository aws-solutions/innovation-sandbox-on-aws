FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@sha256:c9a8457247e453f635fda07121cce4fc16c2219290ca4e5494959e6452fc0244

RUN dnf install -y tar gzip awscli jq sed

ADD https://github.com/ekristen/aws-nuke/releases/download/v3.56.1/aws-nuke-v3.56.1-linux-amd64.tar.gz nuke-binary.tar.gz

RUN mkdir /tmp/aws-nuke && \
    tar -xzvf nuke-binary.tar.gz -C /tmp/aws-nuke && \
    mv /tmp/aws-nuke/aws-nuke /usr/local/bin/aws-nuke && \
    chmod +x /usr/local/bin/aws-nuke && \
    rm -rf /tmp/aws-nuke && \
    rm nuke-binary.tar.gz

ENV PATH=$PATH:/usr/local/bin

USER codebuild-user
