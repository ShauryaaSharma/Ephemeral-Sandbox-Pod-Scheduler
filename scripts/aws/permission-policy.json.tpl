{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProjectObjectAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::__S3_BUCKET__/code/*"
    },
    {
      "Sid": "ProjectListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::__S3_BUCKET__"
    }
  ]
}
