import { addBreadcrumb } from '@sentry/node-core/light';

type SerializableValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue };

export const parseJson = <T = SerializableValue>(subject: string): T => {
  try {
    return JSON.parse(subject);
  } catch (error) {
    addBreadcrumb({
      data: {
        subject,
      },
      level: 'debug',
      message: 'could not parse JSON',
    });

    throw error;
  }
};
