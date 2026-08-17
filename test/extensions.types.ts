export interface RegisteredTool {
  name: string;
  approval?: string;
  parameters: {
    required?: string[];
    properties?: {
      limit?: {
        maximum?: number;
      };
    };
    ir?: {
      props?: Array<{
        key?: string;
        opt?: boolean;
        val?: {
          max?: number;
        };
      }>;
    };
  };
}
