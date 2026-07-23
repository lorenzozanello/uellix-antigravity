CREATE TABLE "marketing_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"company_name" varchar(255),
	"sroi_result" varchar(50),
	"source" varchar(100) DEFAULT 'sroi_calculator' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
